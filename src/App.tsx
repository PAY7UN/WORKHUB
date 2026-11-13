import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppProvider } from '@/context/AppContext';
import { HomePage } from '@/components/app/HomePage';
import { AppShell } from '@/components/app/shell/AppShell';
import { PasswordNotice } from '@/components/app/shell/PasswordNotice';
import { TopBar } from '@/components/app/shell/TopBar';
import { AdminConsole } from '@/components/app/admin/AdminConsole';
import { ToolsPage } from '@/components/app/tools/ToolsPage';
import { readStore, removeStore, writeStore } from '@/lib/storage';

/**
 * 深链带过来的申请单号（?access=<申请单号>）。
 *
 * 外部把链接转到审批人手里时，审批人点开就该直接落到那条申请上，
 * 而不是自己在一堆申请里翻「哪条是我刚点的」。
 * 这里把它存进 sessionStorage 再把地址栏洗干净：
 * - 存下来是因为中间还隔着「进入工作区」这一步，参数得活过这一跳；
 * - 洗地址栏是因为它是一次性的导航参数，留着会让刷新后反复跳转。
 */
const FOCUS_REQUEST_KEY = 'workhub.focusRequest';
const ENTERED_KEY = 'workhub.entered';

function captureFocusRequest(): void {
  try {
    const id = new URLSearchParams(window.location.search).get('access');
    if (!id) return;
    writeStore(sessionStorage, FOCUS_REQUEST_KEY, id);
    const url = new URL(window.location.href);
    url.searchParams.delete('access');
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* 地址栏改不动就不改，不影响主流程 */
  }
}

interface AppChromeProps {
  entered: boolean;
  onEnter: () => void;
  onExit: () => void;
}

/**
 * 全局外壳：顶栏 + 提醒条 + 当前页面。
 *
 * 这三层以前散在各页面里——工作台自己有顶栏，工具页自己有顶栏，
 * 后台自己又有一套，提示条只长在工作台。结果是：
 * 换个页面对齐变了、提示条没了、内容整体往上蹦一截。
 * 现在收成一处，任何页面看到的都是同一副骨架。
 */
function AppChrome({ entered, onEnter, onExit }: AppChromeProps) {
  const location = useLocation();
  /**
   * 欢迎页是唯一的例外：它有自己的整页排版（大标题、入口卡片），
   * 顶上再压一条应用的顶栏会把那份排版撑破。
   */
  const onWelcome = location.pathname === '/' && !entered;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {!onWelcome && <TopBar onGoHome={onExit} />}
      {!onWelcome && <PasswordNotice />}

      <div className="min-h-0 flex-1">
        <Routes>
          {/* 前台工作区 */}
          <Route
            path="/"
            element={entered ? <AppShell /> : <HomePage onEnter={onEnter} />}
          />
          {/* 工具区：独立页面，对所有登录用户开放 */}
          <Route path="/tools" element={<ToolsPage />} />
          {/* 管理后台：区域 + 分区 */}
          <Route path="/admin" element={<Navigate to="/admin/overview" replace />} />
          <Route path="/admin/:section" element={<AdminConsole />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function App() {
  // 是否已进入工作区（false 时显示主页）
  const [entered, setEntered] = useState(() => {
    // 深链参数必须在首次渲染前抓住：Workspace 挂载后会立刻去读它，
    // 放进 useEffect 就晚了——子组件的副作用先于父组件的副作用跑。
    captureFocusRequest();
    return readStore(sessionStorage, ENTERED_KEY) === '1';
  });

  const handleEnter = () => {
    writeStore(sessionStorage, ENTERED_KEY, '1');
    setEntered(true);
  };

  const handleExit = () => {
    removeStore(sessionStorage, ENTERED_KEY);
    setEntered(false);
  };

  return (
    /*
     * 用 BrowserRouter：URL 就是真实的路径（/tools、/admin/overview），
     * 刷新与深链由服务端的 SPA 兜底路由接住（server/index.ts 静态资源一节）——
     * 非 /api 的路径一律回 index.html，前端拿到后由这里的路由决定渲染什么。
     */
    <BrowserRouter>
      <AppProvider>
        <AppChrome entered={entered} onEnter={handleEnter} onExit={handleExit} />

        <Toaster
          position="top-center"
          richColors
          toastOptions={{
            style: {
              background: 'rgba(255, 255, 255, 0.85)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(99, 102, 241, 0.2)',
              boxShadow: '0 10px 40px rgba(99, 102, 241, 0.15)',
            },
            className: 'font-medium',
          }}
        />
      </AppProvider>
    </BrowserRouter>
  );
}

export default App;
