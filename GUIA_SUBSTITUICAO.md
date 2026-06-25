# GUIA DE SUBSTITUIÇÃO DE EMOJIS — ESCALAÇÃO FC
# Arquivo: /assets/icons/icons.svg

## 1. SETUP (fazer uma vez)

### No index.html — adicionar o sprite inline logo após <body>:
```html
<body>
  <!-- SVG Sprite — carregado uma vez, offline-ready -->
  <div id="svg-sprite" style="display:none">
    <!-- Cole aqui TODO o conteúdo do arquivo icons.svg -->
  </div>
  ...
```

> **Por que inline e não <img src>?**
> Inline = zero requisição de rede, funciona offline/APK garantido.
> O navegador faz cache do HTML inteiro. Alternativa para APK nativo:
> basta empacotar o arquivo icons.svg junto com o app.


### No app.js — adicionar o componente Icon ao objeto Ico:

```js
// Componente genérico — adicionar ao topo do app.js
const Icon = ({ id, size = 18, style = {}, className = "" }) => (
  <svg
    width={size}
    height={size}
    style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    className={className}
    aria-hidden="true"
  >
    <use href={`/assets/icons/icons.svg#${id}`} />
  </svg>
);

// Adicionar ao objeto Ico existente:
const Ico = {
  // ... ícones já existentes ...

  // Novos (substituem emojis):
  Soccer:      ()=><Icon id="soccer-ball" />,
  Goalkeeper:  ()=><Icon id="goalkeeper" />,
  Ticket:      ()=><Icon id="ticket" />,
  CheckCircle: ()=><Icon id="check-circle" />,
  XCircle:     ()=><Icon id="x-circle" />,
  Warning:     ()=><Icon id="warning" />,
  Info:        ()=><Icon id="info" />,
  Clipboard:   ()=><Icon id="clipboard" />,
  ChartBar:    ()=><Icon id="chart-bar" />,
  CalendarIco: ()=><Icon id="calendar" />,
  MapPin:      ()=><Icon id="map-pin" />,
  Clock:       ()=><Icon id="clock" />,
  Stopwatch:   ()=><Icon id="stopwatch" />,
  People:      ()=><Icon id="users" />,
  Person:      ()=><Icon id="person" />,
  Jersey:      ()=><Icon id="jersey" />,
  Trophy:      ()=><Icon id="trophy" />,
  Medal:       ()=><Icon id="medal" />,
  Target:      ()=><Icon id="target" />,
  Balance:     ()=><Icon id="balance" />,
  Dice:        ()=><Icon id="dice" />,
  Lightning:   ()=><Icon id="lightning" />,
  Fire:        ()=><Icon id="fire" />,
  Stadium:     ()=><Icon id="stadium" />,
  Money:       ()=><Icon id="money-bag" />,
  Banknote:    ()=><Icon id="banknote" />,
  Receipt:     ()=><Icon id="receipt" />,
  CreditCard:  ()=><Icon id="credit-card" />,
  Lock:        ()=><Icon id="lock" />,
  Eye:         ()=><Icon id="eye" />,
  Search:      ()=><Icon id="search" />,
  Refresh:     ()=><Icon id="refresh" />,
  Shuffle:     ()=><Icon id="shuffle" />,
  Repeat:      ()=><Icon id="repeat" />,
  Link:        ()=><Icon id="link" />,
  Pin:         ()=><Icon id="pin" />,
  Tag:         ()=><Icon id="tag" />,
  Bulb:        ()=><Icon id="bulb" />,
  Cloud:       ()=><Icon id="cloud" />,
  Moon:        ()=><Icon id="moon" />,
  Sun:         ()=><Icon id="sun" />,
  Radio:       ()=><Icon id="radio" />,
  Party:       ()=><Icon id="party" />,
  Sad:         ()=><Icon id="sad" />,
  Gem:         ()=><Icon id="gem" />,
  Memo:        ()=><Icon id="memo" />,
  FolderOpen:  ()=><Icon id="folder-open" />,
  Upload:      ()=><Icon id="upload" />,
  Crown:       ()=><Icon id="crown" />,
  HomeIco:     ()=><Icon id="home" />,
  Airplane:    ()=><Icon id="airplane" />,
  Handshake:   ()=><Icon id="handshake" />,
  Festival:    ()=><Icon id="festival" />,
  Competition: ()=><Icon id="competition" />,

  // Status de jogador:
  PlayerActive:    ()=><Icon id="active" />,
  PlayerInjured:   ()=><Icon id="injured" />,
  PlayerSuspended: ()=><Icon id="suspended" />,
  PlayerInactive:  ()=><Icon id="inactive" />,

  // Skill faces:
  Skill1: ()=><Icon id="skill-1" />,
  Skill2: ()=><Icon id="skill-2" />,
  Skill3: ()=><Icon id="skill-3" />,
  Skill4: ()=><Icon id="skill-4" />,
};
```

---

## 2. TABELA DE SUBSTITUIÇÃO

### Emojis em JSX (nos componentes React)

| Emoji | Onde aparece (contexto) | Substituir por |
|-------|------------------------|----------------|
| ⚽ | Títulos, lista de jogadores, badges | `<Ico.Soccer size={18}/>` |
| ✅ | Toast, status pago, confirmações | `<Ico.CheckCircle/>` |
| ❌ | Status não pago, derrotas | `<Ico.XCircle/>` |
| ⚠️ | Toast de erro, alertas | `<Ico.Warning/>` |
| 📋 | Presenças, clipboard, escalações | `<Ico.Clipboard/>` |
| 🎟️ | Badge de convidado | `<Ico.Ticket/>` |
| 📅 | Data, calendário, jogos | `<Ico.CalendarIco/>` |
| 🕐 | Horário | `<Ico.Clock/>` |
| 📍 | Local | `<Ico.MapPin/>` |
| 👥 | Jogadores convocados, mensalistas | `<Ico.People/>` |
| 📊 | Estatísticas, gráficos | `<Ico.ChartBar/>` |
| 🏆 | Vitórias, torneio | `<Ico.Trophy/>` |
| 🏅 | Ranking, medalha | `<Ico.Medal/>` |
| 🎯 | Assistências | `<Ico.Target/>` |
| 🧤 | Goleiros, gols sofridos | `<Ico.Goalkeeper/>` |
| ⚡ | Avulsos, seção rápida | `<Ico.Lightning/>` |
| ⚖️ | Sorteio equilibrado | `<Ico.Balance/>` |
| 🎲 | Sorteio aleatório | `<Ico.Dice/>` |
| ✏️ | Editar, adicionar sem cadastro | `<Ico.Edit/>` (já existe) |
| 🔒 | Premium bloqueado | `<Ico.Lock/>` |
| 💰 | Caixa do mês | `<Ico.Money/>` |
| 💵 | Saldo em caixa | `<Ico.Banknote/>` |
| 🧾 | Gastos | `<Ico.Receipt/>` |
| 💡 | Dica, instrução | `<Ico.Bulb/>` |
| 🎉 | Times formados, sucesso | `<Ico.Party/>` |
| 🔍 | Busca, lupa | `<Ico.Search/>` |
| 🤝 | Amistoso | `<Ico.Handshake/>` |
| 🎪 | Festival | `<Ico.Festival/>` |
| 🥇 | Campeonato | `<Ico.Medal/>` |
| 🏟️ | Campo/Estádio | `<Ico.Stadium/>` |
| 🏠 | Casa (home/away) | `<Ico.HomeIco/>` |
| ✈️ | Fora (home/away) | `<Ico.Airplane/>` |
| 📝 | Observações | `<Ico.Memo/>` |
| 🔄 | Reserva, resetar | `<Ico.Refresh/>` |
| 🔀 | Mesclar/shuffle | `<Ico.Shuffle/>` |
| 🔁 | Ressortear | `<Ico.Repeat/>` |
| 🔗 | Link/convite | `<Ico.Link/>` |
| 📤 | Exportar/compartilhar | `<Ico.Upload/>` |
| 💎 | Premium/gem | `<Ico.Gem/>` |
| 🌙 | Tema Moderno | `<Ico.Moon/>` |
| ☀️ | Tema Simples | `<Ico.Sun/>` |
| 📻 | Tema Retrô | `<Ico.Radio/>` |
| 📸 | Foto | `<Ico.Camera/>` (já existe) |
| ☁️ | Nuvem/sincronizado | `<Ico.Cloud/>` |
| 👤 | Silhueta/jogador sem foto | `<Ico.Person/>` |
| 👁 | Visualizar | `<Ico.Eye/>` |
| 👕 | Uniforme | `<Ico.Jersey/>` |
| 👑 | Capitão/coroa | `<Ico.Crown/>` |
| 🏷️ | Marca d'água | `<Ico.Tag/>` |
| 📌 | Fixado/pinned | `<Ico.Pin/>` |
| 📂 | Carregar arquivo | `<Ico.FolderOpen/>` |
| 😕 | Estado vazio/triste | `<Ico.Sad/>` |
| ⏱ | Temporizador/expirar | `<Ico.Stopwatch/>` |
| 🔥 | Fire/destaque | `<Ico.Fire/>` |
| 💳 | Mensalidade | `<Ico.CreditCard/>` |

### Status de jogador (linha ~1007)
```js
// ANTES:
{ id:"active",    label:"Ativo",      emoji:"🟢" },
{ id:"injured",   label:"Lesionado",  emoji:"🤕" },
{ id:"suspended", label:"Suspenso",   emoji:"🟥" },
{ id:"inactive",  label:"Inativo",    emoji:"⚫" },

// DEPOIS — trocar "emoji" por "icon":
{ id:"active",    label:"Ativo",      icon:"active",    color:"#34d399" },
{ id:"injured",   label:"Lesionado",  icon:"injured",   color:"#f97316" },
{ id:"suspended", label:"Suspenso",   icon:"suspended", color:"#f87171" },
{ id:"inactive",  label:"Inativo",    icon:"inactive",  color:"#6B7280" },

// No JSX onde renderiza o emoji do status:
// ANTES:  <span>{player.status?.emoji}</span>
// DEPOIS: <Icon id={player.status?.icon} size={14} style={{color: player.status?.color}} />
```

### Skill faces (linha ~2984)
```js
// ANTES:
const SKILL_EMOJI = ["😐","🙂","😊","😎","⭐"];

// DEPOIS:
const SKILL_ICONS = ["skill-1","skill-2","skill-3","skill-4","star"];

// No JSX:
// ANTES:  <span>{SKILL_EMOJI[level]}</span>
// DEPOIS: <Icon id={SKILL_ICONS[level]} size={16} />
```

### Tipos de partida (linha ~6908)
```js
// ANTES:
{id:"friendly",   label:"Amistoso",   emoji:"🤝"},
{id:"festival",   label:"Festival",   emoji:"🎪"},
{id:"tournament", label:"Torneio",    emoji:"🏆"},
{id:"league",     label:"Campeonato", emoji:"🥇"},

// DEPOIS:
{id:"friendly",   label:"Amistoso",   icon:"handshake"},
{id:"festival",   label:"Festival",   icon:"festival"},
{id:"tournament", label:"Torneio",    icon:"trophy"},
{id:"league",     label:"Campeonato", icon:"competition"},
```

### Filtros de estatísticas (linha ~7266)
```js
// ANTES:
{key:"appearances", label:"Presenças",    emoji:"📋", color:"#60a5fa"},
{key:"goals",       label:"Gols",         emoji:"⚽", color:"#34d399"},
{key:"assists",     label:"Assistências", emoji:"🎯", color:"#f59e0b"},
{key:"goalsAgainst",label:"Gols sofridos",emoji:"🧤", color:"#f87171"},

// DEPOIS (trocar "emoji" por "icon"):
{key:"appearances", label:"Presenças",    icon:"clipboard",  color:"#60a5fa"},
{key:"goals",       label:"Gols",         icon:"soccer-ball",color:"#34d399"},
{key:"assists",     label:"Assistências", icon:"target",      color:"#f59e0b"},
{key:"goalsAgainst",label:"Gols sofridos",icon:"goalkeeper", color:"#f87171"},

// No JSX onde renderiza: <Icon id={stat.icon} size={13} style={{color: stat.color}} />
```

---

## 3. EMOJIS QUE FICAM (não alterar)

Estes estão em strings de texto para WhatsApp/exportação — são parte da mensagem de texto, não da UI:

- Linhas ~2513–2578: `buildFinanceText()` → strings para copiar/compartilhar
- Linhas ~7340–7357: `buildConvocationText()` → convocação WhatsApp
- Linhas ~8375–8384: `buildMatchText()` → resultado de partida
- Canvas (`ctx.fillText`): ícones no canvas de imagem gerada (⚽, 📊, 🛡)
- `shareText` / `shareTitle`: metadados de compartilhamento

---

## 4. ICONS QUE JÁ EXISTEM EM Ico (não recriar)

Plus, Edit, Trash, Close, Shield, Users, Tactic, Camera, Gallery,
ChevL, ChevR, ChevDown, Share, Download, List, Back, Home, Palette,
Save, Lineup, Star2, NavHome, NavTactic, NavOffice, Calendar, Stats,
Import, Players, Goal, Clock, MapPin, Trophy, Bell, Image, Send

---

## 5. CONTROLE DE COR POR CSS

```css
/* Para ícones coloridos, aplicar via style ou classe: */
.ico-green  { color: #34d399; }
.ico-red    { color: #f87171; }
.ico-yellow { color: #f59e0b; }
.ico-blue   { color: #60a5fa; }
.ico-gray   { color: #9CA3AF; }
```

```jsx
/* No JSX: */
<Icon id="check-circle" size={14} style={{color:"#34d399"}} />
<Icon id="warning"      size={14} style={{color:"#f59e0b"}} />
```
