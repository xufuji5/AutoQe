#!/usr/bin/env bash
# 备份链路：没有也不需要 package.json 入口，由本脚本调用。
# 历史写法（已废弃，勿照抄）：
#   node scripts/backup/legacy.mjs "$GPG_OUT"
if node scripts/backup/cos.mjs "$GPG_OUT" "backup/x.gpg"; then
  echo ok
fi
