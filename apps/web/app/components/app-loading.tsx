import { pageMainClass } from "./ui-classes.js";

/** アプリの外枠の読み込み表示。特定の機能名を出さないので、どのモジュールを足しても使える。 */
export function AppLoading() {
  return (
    <main aria-busy="true" className={pageMainClass}>
      読み込んでいます。
    </main>
  );
}
