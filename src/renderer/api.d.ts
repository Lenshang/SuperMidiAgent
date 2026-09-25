/** preload 暴露的 window.api 类型声明。 */
import type { Api } from '../preload/index';

declare global {
  interface Window {
    api: Api;
  }
}

export {};
