/**
 * 繰り返し使う Tailwind ユーティリティの単一の出どころ。
 *
 * 色・余白の散逸を防ぐための置き場所で、見た目の派手さは持たせない。
 * 一度しか使わない配置は各画面に直接書く。
 */
export const pageMainClass = "mx-auto w-full max-w-4xl px-6 py-8";

export const pageTitleClass = "mb-4 text-2xl font-extrabold tracking-tight";

export const primaryButtonClass =
  "inline-block rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-500 dark:hover:bg-blue-400";

export const ghostButtonClass =
  "inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800";

export const dangerButtonClass =
  "inline-block rounded-lg bg-red-700 px-4 py-2 font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-red-500 dark:hover:bg-red-400";

export const dangerOutlineButtonClass =
  "inline-block rounded-lg border border-red-300 px-4 py-2 font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950";

export const statusBadgeClass =
  "inline-block rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-blue-700 dark:bg-blue-950 dark:text-blue-300";

export const alertBoxClass =
  "rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950";

export const alertMessageClass =
  "text-sm font-medium text-red-800 dark:text-red-200";

export const alertDetailClass = "mt-1 text-sm text-red-700 dark:text-red-300";

export const alertCodeClass =
  "rounded bg-red-100 px-1.5 font-mono text-[0.875em] dark:bg-red-900 dark:text-red-100";

export const fieldLabelClass = "text-sm font-bold";

export const textInputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900";
