// Dev identity を結び付ける固定の user。DB の seed（seed.ts）と NODE_ENV=test の memory fixture
// （fixtures.ts）が同じ ID を使うので、どちらで起動しても Dev ログインの利用者が Alpha の所有者になる。
export const devUserId = "user_local_developer";
