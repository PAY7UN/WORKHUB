// WorkHub 服务端的 Windows 服务宿主。
//
// 为什么自己写一个，而不是用 nssm / winsw：
// 那两个都是要单独下载的第三方 exe，部署到客户服务器上就多了一份来路不明的二进制，
// 而且升级、查杀软兼容、免安装包分发都要额外操心。这里用系统自带的 .NET Framework
// 编译器（csc.exe，Win10/11 与 Server 2012+ 都带）现场编一个几十 KB 的小 exe，
// 依赖为零。
//
// 干的事很朴素：把 node 当子进程拉起来，把它的输出转到日志文件，
// 收到 SCM 的停止指令时让它优雅退出（走服务端的 /api/manage/shutdown）。
//
// 有一处不能将就：宿主进程被杀时，node 子进程会变成孤儿继续占着端口，
// 下一次服务启动就撞 EADDRINUSE。这里用 Windows 的 Job Object 把子进程
// 绑在宿主身上——宿主一死，作业里的进程跟着一起死。
//
// 注意：C# 5 语法（csc.exe 4.0.30319 只支持到 C# 5）：
// 不能用字符串插值 $""、不能有 ?.、不能用 nameof、不能用表达式体成员。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace WorkHub
{
    /// <summary>服务配置：一份 key=value 的纯文本，避免在 C# 里引 JSON 库。</summary>
    internal sealed class ServiceConfig
    {
        public string Node = "";
        public string Dir = "";
        public string Args = "";
        public string Log = "";
        // 服务入口（相对 dir）。留空则按约定自动探测，见 EntryResolver。
        public string Entry = "";
        // 镜像值：真源在 shared/constants.ts 的 DEFAULT_API_PORT。
        // .NET Framework 4 没有 JSON 解析器，读不了那份常量，只能各写一份。
        public int Port = 8787;
        public string Token = "";
        public string Name = "WorkHub";
        public string DisplayName = "WorkHub 文档服务";
        public int StopTimeoutSeconds = 15;

        /// <summary>读配置。缺项不报错：缺的按默认值来，多的忽略。</summary>
        public static ServiceConfig Load(string path)
        {
            ServiceConfig cfg = new ServiceConfig();
            Dictionary<string, string> kv = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (File.Exists(path))
            {
                foreach (string raw in File.ReadAllLines(path))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#") || line.StartsWith(";")) continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    kv[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                }
            }

            cfg.Node = Get(kv, "node", cfg.Node);
            cfg.Dir = Get(kv, "dir", cfg.Dir);
            cfg.Args = Get(kv, "args", cfg.Args);
            cfg.Log = Get(kv, "log", cfg.Log);
            cfg.Entry = Get(kv, "entry", cfg.Entry);
            cfg.Token = Get(kv, "token", cfg.Token);
            cfg.Name = Get(kv, "name", cfg.Name);
            cfg.DisplayName = Get(kv, "displayName", cfg.DisplayName);
            cfg.Port = GetInt(kv, "port", cfg.Port);
            cfg.StopTimeoutSeconds = GetInt(kv, "stopTimeoutSeconds", cfg.StopTimeoutSeconds);
            return cfg;
        }

        private static string Get(Dictionary<string, string> kv, string key, string fallback)
        {
            string v;
            return kv.TryGetValue(key, out v) && v.Length > 0 ? v : fallback;
        }

        private static int GetInt(Dictionary<string, string> kv, string key, int fallback)
        {
            string v;
            int parsed;
            if (kv.TryGetValue(key, out v) && int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
            {
                return parsed;
            }
            return fallback;
        }
    }

    /// <summary>
    /// 服务入口的约定（真源在 scripts/lib/service-entry.mjs，规则改动要同步）。
    ///
    ///   1. dir/.workhub-entry 里写的相对路径（可选）
    ///   2. dir/server/index.js —— 编译产物，发布包里用这一份
    ///   3. dir/server/index.ts —— 源码直跑，仓库形态用这一份
    ///
    /// 为什么要在这儿探一次：服务端既能被「node server/index.ts」直跑，
    /// 也能被编译成「node server/index.js」发布。老配置里写死的是 .ts，
    /// 升级到带编译产物的新包后入口必须跟着换，否则服务起不来。
    /// </summary>
    internal static class EntryResolver
    {
        public static string Detect(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return null;
            try
            {
                string manifest = Path.Combine(dir, ".workhub-entry");
                if (File.Exists(manifest))
                {
                    string[] lines = File.ReadAllLines(manifest);
                    foreach (string raw in lines)
                    {
                        string line = raw.Trim();
                        if (line.Length == 0) continue;
                        string rel = line.Replace('\\', '/');
                        if (File.Exists(Path.Combine(dir, rel))) return rel;
                    }
                }
            }
            catch { }

            if (File.Exists(Path.Combine(dir, "server", "index.js"))) return "server/index.js";
            if (File.Exists(Path.Combine(dir, "server", "index.ts"))) return "server/index.ts";
            return null;
        }

        /// <summary>
        /// 拼出启动参数：前置参数照旧，入口按约定换。
        ///
        /// 老配置把入口混在 args 里（"--env-file-if-exists=.env server/index.ts"），
        /// 这里把那个入口 token 换成探测出来的；新配置里入口单独放在 entry 字段。
        /// </summary>
        public static string ResolveArguments(ServiceConfig cfg)
        {
            string entry = !string.IsNullOrEmpty(cfg.Entry) ? cfg.Entry : Detect(cfg.Dir);
            if (string.IsNullOrEmpty(entry)) return cfg.Args;

            string[] parts = cfg.Args.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            List<string> kept = new List<string>();
            bool replaced = false;
            foreach (string part in parts)
            {
                string normalized = part.Replace('\\', '/');
                bool looksLikeEntry = normalized.EndsWith("/index.ts") || normalized.EndsWith("/index.js")
                    || normalized == "index.ts" || normalized == "index.js";
                if (looksLikeEntry && !replaced)
                {
                    kept.Add(entry);
                    replaced = true;
                    continue;
                }
                kept.Add(part);
            }
            if (!replaced) kept.Add(entry);
            return string.Join(" ", kept.ToArray());
        }
    }

    /// <summary>把 node 的输出写进日志文件。</summary>
    internal sealed class LogSink : IDisposable
    {
        private readonly object gate = new object();
        private StreamWriter writer;

        public LogSink(string path)
        {
            try
            {
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                // FileShare.ReadWrite：日志要能被 tail 工具读，宿主独占会挡住别人看
                writer = new StreamWriter(
                    new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
                    new UTF8Encoding(false));
                writer.AutoFlush = true;
            }
            catch (Exception ex)
            {
                writer = null;
                Console.Error.WriteLine("日志文件打不开：" + ex.Message);
            }
        }

        public void Write(string level, string message)
        {
            string line = string.Format(
                CultureInfo.InvariantCulture,
                "{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}",
                DateTime.Now, level, message);
            lock (gate)
            {
                if (writer != null)
                {
                    writer.WriteLine(line);
                    return;
                }
                Console.Error.WriteLine(line);
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (writer != null)
                {
                    try { writer.Dispose(); } catch { }
                    writer = null;
                }
            }
        }
    }

    /// <summary>
    /// 服务本体。抽成普通类是为了让 console 模式也能复用同一套「拉起、停止」逻辑。
    /// </summary>
    internal sealed class WorkHubRunner
    {
        private readonly ServiceConfig cfg;
        private readonly LogSink log;
        private readonly object gate = new object();
        private Process child;
        private DateTime childStartedAt = DateTime.MinValue;
        private IntPtr jobHandle = IntPtr.Zero;
        private volatile bool stopping;
        private Thread watchdog;
        private int restartStreak;

        /// <summary>连续拉起失败多少次后就放弃，交给服务管理器</summary>
        private const int MaxRestartStreak = 5;

        /// <summary>稳定运行超过这么久，才算这次拉起真的成功了</summary>
        private const int StableSeconds = 30;

        public WorkHubRunner(ServiceConfig cfg, LogSink log)
        {
            this.cfg = cfg;
            this.log = log;
        }

        public bool HasChild { get { return child != null; } }

        /// <summary>停完了就置位（console 模式靠它退出）</summary>
        public ManualResetEvent Stopped = new ManualResetEvent(false);

        /// <summary>拉起 node。</summary>
        public void Start()
        {
            if (string.IsNullOrEmpty(cfg.Node))
            {
                throw new InvalidOperationException("配置里没有 node 路径");
            }
            if (!File.Exists(cfg.Node))
            {
                throw new FileNotFoundException("找不到 node 可执行文件：" + cfg.Node, cfg.Node);
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = cfg.Node;
            psi.Arguments = EntryResolver.ResolveArguments(cfg);
            psi.WorkingDirectory = string.IsNullOrEmpty(cfg.Dir) ? Environment.CurrentDirectory : cfg.Dir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            // 告诉服务端「外面有宿主在管着你」。
            // 自动升级要靠它判断升级后该由谁把服务拉起来：宿主有看门狗，
            // 升级器就不用自己拉，两个都拉会抢同一个端口。
            psi.EnvironmentVariables["WORKHUB_SERVICE_HOST"] = "1";

            log.Write("info", "拉起服务：" + psi.FileName + " " + psi.Arguments + "（工作目录 " + psi.WorkingDirectory + "）");

            Process proc = new Process();
            proc.StartInfo = psi;
            proc.EnableRaisingEvents = true;
            proc.Exited += OnChildExited;

            if (!proc.Start())
            {
                throw new InvalidOperationException("node 进程启动失败");
            }

            // 把子进程关进 Job Object：宿主被杀时，node 跟着一起死，
            // 不留一个孤儿占着端口（孤儿会让下一次服务启动撞 EADDRINUSE）。
            AttachToJob(proc);

            lock (gate)
            {
                child = proc;
                childStartedAt = DateTime.Now;
            }

            Pump(proc.StandardOutput, "info");
            Pump(proc.StandardError, "error");
        }

        /// <summary>
        /// 看门狗：node 崩了自己拉起来。
        ///
        /// 为什么不在宿主里做、而是交给服务管理器（systemd / SCM / 任务计划）：
        /// 外部的重启策略各有各的脾气——任务计划程序就不会重启「被终止」的任务，
        /// 靠它就等于赌运气。放在宿主里，两种安装方式的行为才是一套的。
        ///
        /// 连续拉起失败太多次就放弃，让宿主带着非零码退出，
        /// 这时该由服务管理器接手（或者干脆让人来看一眼）。
        /// </summary>
        public void StartWatchdog()
        {
            watchdog = new Thread(WatchdogLoop);
            watchdog.IsBackground = true;
            watchdog.Start();
        }

        private void WatchdogLoop()
        {
            while (!stopping)
            {
                Thread.Sleep(2000);
                if (stopping) return;

                Process current;
                DateTime startedAt;
                lock (gate)
                {
                    current = child;
                    startedAt = childStartedAt;
                }
                if (current == null) continue;

                bool exited;
                try { exited = current.HasExited; } catch { exited = true; }
                if (!exited) continue;

                // 正在升级：先别拉。
                // 升级器要换掉代码目录里的文件，这时候拉起来的是旧代码，
                // 等它换完再启动新代码就会撞端口。而升级器换完会撤掉标记，
                // 那时我们再拉。
                if (WaitForUpgradeToFinish())
                {
                    if (stopping) return;
                    try
                    {
                        lock (gate) { child = null; }
                        Start();
                        log.Write("info", "升级完成，已拉起新版本服务进程");
                    }
                    catch (Exception ex)
                    {
                        log.Write("error", "升级后拉起失败：" + ex.Message);
                    }
                    continue;
                }

                // 这次跑够久了，说明上一轮是正常的，计数重新开始
                if ((DateTime.Now - startedAt).TotalSeconds > StableSeconds)
                {
                    restartStreak = 0;
                }
                restartStreak += 1;

                if (restartStreak > MaxRestartStreak)
                {
                    log.Write("error", "连续 " + restartStreak + " 次拉起失败，宿主退出，请人工看一眼（" + cfg.Log + "）");
                    Environment.Exit(1);
                    return;
                }

                // 退避：连着崩就等久一点，别把 CPU 烧在反复拉起上
                int delay = Math.Min(30, restartStreak * 5);
                log.Write("warn", delay + " 秒后重新拉起（第 " + restartStreak + " 次）");
                Thread.Sleep(delay * 1000);
                if (stopping) return;

                try
                {
                    lock (gate) { child = null; }
                    Start();
                    log.Write("info", "已重新拉起服务进程");
                }
                catch (Exception ex)
                {
                    log.Write("error", "重新拉起失败：" + ex.Message);
                }
            }
        }

        /// <summary>
        /// 升级标记文件的位置。
        ///
        /// 放在代码目录（node 的工作目录）下：服务端换代码时也在那儿，
        /// 双方看到的是同一个文件。
        /// </summary>
        private string UpgradeFlagPath
        {
            get
            {
                string dir = string.IsNullOrEmpty(cfg.Dir) ? Environment.CurrentDirectory : cfg.Dir;
                return Path.Combine(dir, ".upgrade-in-progress");
            }
        }

        /// <summary>
        /// 正在升级的话就等它换完。
        ///
        /// 升级器要替换代码目录里的文件，这时候我们拉起来的还是旧代码——
        /// 等它换完，新旧两个进程抢同一个端口，升级反而搞砸了。
        /// 升级器换完会撤掉标记，那时再拉。
        ///
        /// 返回 true 表示「刚才是升级，现在可以拉了」。
        /// </summary>
        private bool WaitForUpgradeToFinish()
        {
            string flag = UpgradeFlagPath;
            if (!File.Exists(flag)) return false;

            log.Write("info", "检测到升级标记，等升级完成后再拉起服务");
            int waited = 0;
            while (File.Exists(flag) && !stopping && waited < 600)
            {
                Thread.Sleep(1000);
                waited += 1;
            }
            if (stopping) return false;
            if (File.Exists(flag))
            {
                log.Write("warn", "升级标记 10 分钟没消失（升级多半失败了），自己拉起来");
                return false;
            }
            log.Write("info", "升级标记已撤销，可以拉起新版本");
            return true;
        }

        /// <summary>子进程输出泵。必须持续读，否则管道写满会把子进程卡死。</summary>
        private void Pump(StreamReader reader, string defaultLevel)
        {
            Thread thread = new Thread(delegate()
            {
                try
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        log.Write(DetectLevel(line, defaultLevel), line);
                    }
                }
                catch (Exception ex)
                {
                    log.Write("warn", "读取子进程输出出错：" + ex.Message);
                }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        /// <summary>
        /// 认日志级别。
        ///
        /// 服务端的日志形如 [workhub][warn] 端口被占用……
        /// 而 stderr 在很多程序里混着 warn 和 error 两种级别。
        /// 一律按 error 记的话，运维翻日志时会满屏红色，真正的错误反而被埋了。
        /// 所以按行首的级别标记来定，而不是按它从哪个流出来。
        /// </summary>
        private static string DetectLevel(string line, string fallback)
        {
            int firstClose = line.IndexOf(']');
            if (firstClose < 0) return fallback;
            int open = line.IndexOf('[', firstClose);
            if (open < 0) return fallback;
            int close = line.IndexOf(']', open + 1);
            if (close < 0) return fallback;

            string tag = line.Substring(open + 1, close - open - 1);
            switch (tag)
            {
                case "error":
                case "warn":
                case "info":
                case "debug":
                case "notice":
                    return tag;
                default:
                    return fallback;
            }
        }

        /// <summary>node 自己退了：不是我们让它退的，说明出事了。</summary>
        private void OnChildExited(object sender, EventArgs e)
        {
            int code = -1;
            try
            {
                Process exited = sender as Process;
                if (exited != null) code = exited.ExitCode;
            }
            catch { }
            if (stopping)
            {
                log.Write("info", "服务进程已退出（退出码 " + code + "）");
                return;
            }
            // 这里不直接退出：拉起 node 的事交给看门狗线程，
            // 由它决定重试还是放弃。事件回调里做重启容易和停止流程打架。
            log.Write("warn", "服务进程意外退出（退出码 " + code + "）");
        }

        /// <summary>停止：先让它自己收摊，不行再动粗。</summary>
        public void Stop()
        {
            stopping = true;

            Process current;
            lock (gate) { current = child; }
            if (current == null)
            {
                Stopped.Set();
                return;
            }

            // 优雅停机：走服务端的停机接口，让它把事务收干净、把日志写完
            if (!string.IsNullOrEmpty(cfg.Token))
            {
                try
                {
                    RequestShutdown();
                    log.Write("info", "已请求服务优雅停止");
                }
                catch (Exception ex)
                {
                    log.Write("warn", "优雅停止请求失败，改用强杀：" + ex.Message);
                }
            }
            else
            {
                log.Write("warn", "配置里没有机器令牌，只能强杀进程（可能有事务被腰斩）");
            }

            try
            {
                if (current.WaitForExit(cfg.StopTimeoutSeconds * 1000))
                {
                    log.Write("info", "服务进程已退出");
                    Stopped.Set();
                    return;
                }
            }
            catch (Exception ex)
            {
                log.Write("warn", "等待子进程退出出错：" + ex.Message);
            }

            log.Write("warn", "等待超时，强杀进程树");
            KillTree(current.Id);
            try { current.WaitForExit(5000); } catch { }
            Stopped.Set();
        }

        /// <summary>调服务端的停机接口。</summary>
        private void RequestShutdown()
        {
            string url = "http://127.0.0.1:" + cfg.Port.ToString(CultureInfo.InvariantCulture) + "/api/manage/shutdown";
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "POST";
            request.Timeout = 5000;
            // 本机请求不走代理：系统代理设置会把 127.0.0.1 也代理走，然后卡死
            request.Proxy = null;
            request.Headers.Add("x-workhub-token", cfg.Token);
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                log.Write("info", "停机接口返回 " + (int)response.StatusCode);
            }
        }

        /// <summary>杀整棵进程树。node 可能自己拉了子进程（管理接口的「自己再起一个」）。</summary>
        private void KillTree(int pid)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process killer = Process.Start(psi))
                {
                    if (killer != null) killer.WaitForExit(10000);
                }
            }
            catch (Exception ex)
            {
                log.Write("error", "强杀失败：" + ex.Message);
            }
        }

        // ---- Job Object：让子进程跟着宿主一起死 ----

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformationStruct
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int infoClass,
            IntPtr info,
            uint infoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private void AttachToJob(Process proc)
        {
            try
            {
                IntPtr job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    log.Write("warn", "创建 Job Object 失败，子进程不会随宿主退出（残留时会占端口）");
                    return;
                }

                JobObjectExtendedLimitInformationStruct info = new JobObjectExtendedLimitInformationStruct();
                info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;

                int size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformationStruct));
                IntPtr ptr = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(info, ptr, false);
                    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size))
                    {
                        log.Write("warn", "设置 Job Object 失败，错误码 " + Marshal.GetLastWin32Error());
                        CloseHandle(job);
                        return;
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(ptr);
                }

                if (!AssignProcessToJobObject(job, proc.Handle))
                {
                    // 常见于宿主自己已经在别的作业里（任务计划程序、CI 等）：降级，不强求
                    log.Write("warn", "子进程没能关进 Job Object（错误码 " + Marshal.GetLastWin32Error()
                        + "），宿主被杀时可能留下孤儿进程");
                    CloseHandle(job);
                    return;
                }

                jobHandle = job;
                log.Write("info", "子进程已关进 Job Object，宿主退出时它会跟着退出");
            }
            catch (Exception ex)
            {
                log.Write("warn", "设置 Job Object 出错：" + ex.Message);
            }
        }

        public void Dispose()
        {
            if (jobHandle != IntPtr.Zero)
            {
                try { CloseHandle(jobHandle); } catch { }
                jobHandle = IntPtr.Zero;
            }
        }
    }

    /// <summary>Windows 服务入口。</summary>
    internal sealed class WorkHubService : ServiceBase
    {
        private readonly ServiceConfig cfg;
        private readonly LogSink log;
        private WorkHubRunner runner;

        public WorkHubService(string configPath)
        {
            cfg = ServiceConfig.Load(configPath);
            ServiceName = cfg.Name;
            CanStop = true;
            CanShutdown = true;
            CanPauseAndContinue = false;
            log = new LogSink(cfg.Log);
        }

        protected override void OnStart(string[] args)
        {
            log.Write("info", "服务启动中：" + cfg.DisplayName);
            runner = new WorkHubRunner(cfg, log);
            try
            {
                runner.Start();
                runner.StartWatchdog();
                log.Write("info", "服务已启动");
            }
            catch (Exception ex)
            {
                log.Write("error", "服务启动失败：" + ex.Message);
                throw;
            }
        }

        protected override void OnStop()
        {
            log.Write("info", "收到停止指令");
            // 停止可能要花点时间（等它优雅退出），别让 SCM 因为超时直接杀掉宿主
            RequestAdditionalTime(30000);
            try
            {
                if (runner != null) runner.Stop();
            }
            finally
            {
                log.Write("info", "服务已停止");
            }
        }

        protected override void OnShutdown()
        {
            log.Write("info", "收到系统关机指令");
            try
            {
                if (runner != null) runner.Stop();
            }
            catch { }
        }
    }

    internal static class Program
    {
        private const string ConfigFileName = "service.conf";

        private static int Main(string[] args)
        {
            // console 模式：不走服务管理器，前台跑。
            // 用来在没有管理员权限的机器上验证宿主的启停逻辑，也方便排查问题。
            if (args.Length > 0 && args[0] == "--console")
            {
                return RunConsole(args);
            }

            string configPath = ConfigPath();
            ServiceBase.Run(new WorkHubService(configPath));
            return 0;
        }

        private static string ConfigPath()
        {
            // 优先看 exe 同目录；装到 %ProgramData%\WorkHub\service 时就是那儿
            string beside = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ConfigFileName);
            if (File.Exists(beside)) return beside;
            string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "WorkHub", ConfigFileName);
            return fallback;
        }

        private static int RunConsole(string[] args)
        {
            string configPath = args.Length > 1
                ? args[1]
                : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ConfigFileName);

            ServiceConfig cfg = ServiceConfig.Load(configPath);
            LogSink log = new LogSink(cfg.Log);
            WorkHubRunner runner = new WorkHubRunner(cfg, log);

            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e)
            {
                e.Cancel = true;
                log.Write("info", "收到 Ctrl+C，停止服务");
                runner.Stop();
                Environment.Exit(0);
            };

            try
            {
                runner.Start();
                runner.StartWatchdog();
            }
            catch (Exception ex)
            {
                log.Write("error", "启动失败：" + ex.Message);
                return 1;
            }

            // --console --run <秒>：跑够时间就自己停，用来无人值守地验证启停
            int runSeconds = 0;
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--run")
                {
                    int parsed;
                    if (int.TryParse(args[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
                    {
                        runSeconds = parsed;
                    }
                }
            }

            if (runSeconds > 0)
            {
                if (!runner.Stopped.WaitOne(runSeconds * 1000))
                {
                    log.Write("info", "到达指定运行时间，停止服务");
                    runner.Stop();
                }
                return 0;
            }

            // 前台等着。node 崩了不要紧，看门狗会把它拉起来，宿主继续守着。
            runner.Stopped.WaitOne();
            return 0;
        }
    }
}
