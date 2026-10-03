import React from "react";
import { clearPersistedQueryCache } from "@/lib/query-persist";

interface AppErrorBoundaryState {
  error: Error | null;
}

/**
 * 全域錯誤邊界：任何頁面渲染時拋出未捕捉錯誤，改顯示可讀的錯誤畫面
 * （而不是整頁白屏），並提供「清除快取重新載入」讓使用者自救——
 * 常見成因是新版程式還原了舊版格式的本機快取。
 */
export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 渲染崩潰極可能來自過期的持久化快取；先清掉，
    // 使用者重新載入後就會抓全新資料。
    clearPersistedQueryCache();
    // eslint-disable-next-line no-console
    console.error("頁面渲染發生錯誤", error, info.componentStack);
  }

  private handleReload = (): void => {
    clearPersistedQueryCache();
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
          <div className="w-full max-w-md space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-6 text-center shadow-xl">
            <h1 className="text-lg font-semibold">頁面載入發生錯誤</h1>
            <p className="text-sm text-slate-300">
              可能是瀏覽器留存的舊版快取與新版程式不相容。點下方按鈕清除快取並重新載入即可恢復。
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
            >
              清除快取並重新載入
            </button>
            <p className="break-all text-xs text-slate-500">
              錯誤訊息：{this.state.error.message}
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
