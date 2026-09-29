export type Project = {
  id: string;
  /** 作成した利用者。一覧・取得・更新はすべてこの値で絞るので、他人の Project は見えない。 */
  ownerUserId: string;
  name: string;
  status: "active" | "archived";
  version: number;
  /** 作成後に変わらない。一覧はこの値の新しい順に並ぶ。 */
  createdAt: Date;
  updatedAt: Date;
};
