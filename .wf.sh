# 把 .emu.sh 接进 workflow：在 Wait for Android boot 之后、Watch daily rewarded ads 之前
node -e "
const fs=require('fs');
const p='.github/workflows/arityflow-ads.yml';
let y=fs.readFileSync(p,'utf8');
// 找到 'Watch daily rewarded ads' 步骤前插入清除模拟器指纹的步骤
const anchor='      - name: Watch daily rewarded ads';
if(!y.includes(anchor)){console.error('anchor not found');process.exit(1);}
const step=\`      - name: 清除容器模拟器指纹（广告SDK靠它认模拟器）
        shell: bash
        run: |
          set +e
          bash scripts/clear-emulator-fingerprint.sh diagnostics
          exit 0

\`;
y=y.replace(anchor, step+anchor);
fs.writeFileSync(p,y);
console.log('已插入步骤');
"
