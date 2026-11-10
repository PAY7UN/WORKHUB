import { useState } from 'react';
import { Toaster } from 'sonner';
import { AppProvider } from '@/context/AppContext';
import { HomePage } from '@/components/app/HomePage';
import { AppShell } from '@/components/app/shell/AppShell';
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
    <AppProvider>
      {entered ? <AppShell onGoHome={handleExit} /> : <HomePage onEnter={handleEnter} />}
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
  );
}

export default App;
