import type { UiLocale } from "@bridge/contracts";

/** Copy produced by the planner. Kept in one place so zh/en stay in sync. */
export interface PlanMessages {
  cannotCopy(target: string): string;
  chooseOtherApp: string;
  chooseOverwrite: string;
  cannotOverwrite(target: string): string;
  notCopiedBefore: string;
  overwriteGone: string;
  overwriteChanged: string;
  runningRestart(target: string): string;
  runningBlocked(target: string): string;
  runningStatus(target: string): string;
  backupNote: string;
}

const zh: PlanMessages = {
  cannotCopy: (target) => `当前版本还不能复制到 ${target}。`,
  chooseOtherApp: "请选择另一个应用。",
  chooseOverwrite: "请选择要覆盖的会话。",
  cannotOverwrite: (target) => `当前版本还不能覆盖 ${target} 的会话。`,
  notCopiedBefore: "只能覆盖与这次会话有过复制记录的会话。",
  overwriteGone: "找不到要覆盖的会话，请重新选择。",
  overwriteChanged: "要覆盖的会话在上次复制后有改动，请选择「新建会话」。",
  runningRestart: (target) =>
    `${target} 正在运行。复制后请重启 ${target}，再查看新会话。如果找不到，请关闭应用后再复制一次。`,
  runningBlocked: (target) => `${target} 正在运行。请先退出 ${target}，再重新检查。`,
  runningStatus: (target) => `${target} 正在运行。`,
  backupNote: "复制前会自动备份相关数据。",
};

const en: PlanMessages = {
  cannotCopy: (target) => `The current version cannot copy to ${target} yet.`,
  chooseOtherApp: "Choose a different app.",
  chooseOverwrite: "Choose the session to overwrite.",
  cannotOverwrite: (target) => `The current version cannot overwrite sessions in ${target} yet.`,
  notCopiedBefore: "Only sessions previously copied by ss switch can be overwritten.",
  overwriteGone: "The session to overwrite no longer exists. Choose it again.",
  overwriteChanged: "The session changed after the last copy. Choose “New session”.",
  runningRestart: (target) =>
    `${target} is running. After copying, restart ${target} to see the new session. If it is missing, close the app and copy again.`,
  runningBlocked: (target) => `${target} is running. Quit ${target}, then check again.`,
  runningStatus: (target) => `${target} is running.`,
  backupNote: "Related data is backed up automatically before copying.",
};

export function planMessages(locale?: UiLocale): PlanMessages {
  return locale === "en" ? en : zh;
}
