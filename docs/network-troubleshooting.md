# 局域网联机排障（其它设备连不上）

## 典型症状
- 本机浏览器 `http://localhost:5173` 正常
- 同一台机器的 `http://<局域网IP>:5173` 也正常（可在 WSL 内用 `curl` 验证）
- **其它设备**访问超时 / 无法连接 / 页面打不开或联机一直"连接中"

## 环境前提（本项目）
WSL2 为 **mirrored（镜像）网络模式**：
```
inet 192.168.3.85/24   ← 与 Windows 共享同一局域网 IP
wslinfo --networking-mode → mirrored
```
该模式下 WSL 监听 `*:5173` / `*:8787` 即可被局域网访问，
**唯一的外部阻断来源就是 Windows 防火墙 / Hyper-V 防火墙**。

先在 WSL 内自检（能通说明服务与绑定没问题）：
```bash
curl -I http://192.168.3.85:5173          # 期望 200
node --input-type=module -e "import('ws').then(({WebSocket})=>{const w=new WebSocket('ws://192.168.3.85:8787');w.on('open',()=>{console.log('ws ok');process.exit(0)});w.on('error',e=>{console.log(e.message);process.exit(1)})})"
```

## 修复 1：放行 Windows 防火墙入站端口（最常见）
以**管理员身份**打开 PowerShell（Win+X → 终端(管理员)）：
```powershell
New-NetFirewallRule -DisplayName "OurCraft Web 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "OurCraft LAN 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Any
```
验证：
```powershell
Get-NetFirewallRule -DisplayName "OurCraft*" | Format-Table DisplayName,Enabled,Direction,Action
```

## 修复 2：Hyper-V 防火墙（WSL mirrored 模式特有）
WSL2 在 mirrored 模式下还受 Hyper-V 防火墙约束。管理员 PowerShell：
```powershell
# 查看 WSL 虚拟机防火墙设置
Get-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'

# 方案 A（简单，家用网络可接受）：允许 WSL 默认入站
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow

# 方案 B（更精细）：只为这两个端口放行
New-NetFirewallHyperVRule -Name "OurCraft-LAN" -DisplayName "OurCraft LAN" `
  -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' `
  -Protocol TCP -LocalPorts 5173,8787
```

## 修复 3：确认网络配置为"专用网络"
如果当前网络是"公用"，上面的 `-Profile Any` 规则已覆盖；
但仍建议：设置 → 网络和 Internet → 以太网/WiFi → 网络配置文件 → **专用**。

## 修复 4：如果是 NAT 模式（非 mirrored）
`wslinfo --networking-mode` 显示 `nat` 时，Windows 不会自动监听这两个端口，需要端口转发
（管理员 PowerShell）：
```powershell
$wslIp = (wsl hostname -I).Trim().Split(" ")[0]
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=$wslIp connectport=5173
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8787 connectaddress=$wslIp connectport=8787
netsh interface portproxy show v4tov4
```
> WSL 重启后 IP 会变，需要重新执行。建议改用 `%USERPROFILE%\.wslconfig` 开启 `networkingMode=mirrored`（Win11 22H2+）。

## 修复 5：客户端地址填写
- 页面：`http://192.168.3.85:5173`
- 联机地址：`ws://192.168.3.85:8787`（对话框会自动按页面 hostname 填默认值）
- 不要填 `localhost`（那指向对方自己的机器）
- 房主 IP 变化（DHCP）时需重新确认

## 快速验证是否防火墙
临时关闭防火墙（仅诊断，测完立刻恢复）：
```powershell
Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled False
# 测试其它设备能否访问
Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True
```
若关闭后能连、开启后不能连 → 就是防火墙规则问题，按修复 1/2 添加规则。

## 其它可能
- 路由器开启了 **AP 隔离/客户端隔离**（访客网络常见）：设备之间互相不可见 → 换主网络
- 公司/校园网禁止设备互访
- 本机杀毒软件（第三方防火墙）拦截 node 进程
