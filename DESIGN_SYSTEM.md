# Design System SIGA/SEFAZ-RS v1.0

**Status**: ✅ Implementado em 24/03/2026  
**Scope**: Aplicado a TODOS os módulos, páginas e componentes  
**Regra Principal**: Este design system deve ser aplicado de forma consistente e não pode ser desviado

---

## 🎨 Paleta de Cores

### Cores Primárias

| Nome | Hex | Uso | CSS Variable |
|------|-----|-----|--------------|
| **Header/Estrutura** | `#1F3D3B` | Cabeçalho, navegação, sidebars, estrutura geral | `--design-header` |
| **Primary** | `#3C6E71` | Elementos informativos, botões secundários, estrutura | `--design-primary` |
| **Primary Dark** | `#1F3D3B` | Hovers, gradientes, contraste estrutural | `--design-primary-dark` |

### Cores Funcionais

| Nome | Hex | Uso | CSS Variable |
|------|-----|-----|--------------|
| **Accent (CTA)** | `#D97706` | ⚠️ EXCLUSIVAMENTE botões, CTAs, ações principais | `--design-accent` |
| **Accent Hover** | `#B45309` | Estado hover do accent | `--design-accent-hover` |
| **Accent Active** | `#92400E` | Estado ativo/pressed do accent | `--design-accent-active` |
| **Accent Disabled** | `#FCD9B6` | Estado desabilitado do accent | `--design-accent-disabled` |

### Cores Neutras

| Nome | Hex | Uso | CSS Variable |
|------|-----|-----|--------------|
| **Background** | `#F5F5F4` | Fundo principal, espaços em branco | `--design-background` |
| **Surface** | `#FFFFFF` | Cards, superfícies, modais | `--design-surface` |
| **Border** | `#E5E7EB` | Linhas, divisores, bordas | `--design-border` |

### Cores de Texto

| Nome | Hex | Uso | CSS Variable |
|------|-----|-----|--------------|
| **Primário** | `#1F2A27` | Texto principal, conteúdo | `--design-text-primary` |
| **Secundário** | `#6B7280` | Texto de apoio, labels, subtítulos | `--design-text-secondary` |

### Cores de Estado (Preservadas)

| Estado | Hex | Uso |
|--------|-----|-----|
| **Success** | `#10B981` | Confirmações, ações concluídas |
| **Warning** | `#F59E0B` | Avisos, atenção necessária |
| **Error** | `#EF4444` | Erros, alertas críticos |

---

## 📐 Componentes e Estilos

### Botões

#### Primary (CTA)
- **Background**: `--design-accent` (`#D97706`)
- **Text**: White (`#FFFFFF`)
- **Hover**: `--design-accent-hover` (`#B45309`)
- **Active**: `--design-accent-active` (`#92400E`)
- **Disabled**: `--design-accent-disabled` (`#FCD9B6`)
- **Uso**: Ações principais, CTAs, submissões

```css
.btn-primary {
  background: var(--design-accent);
  color: white;
}
.btn-primary:hover {
  background: var(--design-accent-hover);
}
```

#### Secondary
- **Background**: `--design-primary` (`#3C6E71`)
- **Text**: White
- **Hover**: Derivado de primary mais claro
- **Uso**: Ações secundárias, navegação

```css
.btn-secondary {
  background: var(--design-primary);
  color: white;
}
```

#### Neutral/Outline
- **Background**: Transparent ou `--design-surface`
- **Border**: `--design-border`
- **Text**: `--design-text-primary`
- **Hover**: `--design-background`
- **Uso**: Ações opcionais, navegação

### Cards e Superfícies
- **Background**: `--design-surface` (`#FFFFFF`)
- **Border**: `--design-border` (`#E5E7EB`)
- **Shadow**: `var(--shadow-sm)` - para clareza visual
- **Radius**: `12px` (--radius)

### Headers e Barras
- **Background**: `--design-header` (`#1F3D3B`) com gradiente para lighter (`#2A5154`)
- **Text**: White
- **Accent**: `--design-primary` para destaques
- **Border**: Rgba white com 8-18% opacity

### Badges e Tags

#### Success Badge
- **Background**: `#D1FAE5`
- **Text**: `#065F46`
- **Uso**: Status positivo, concluído

#### Warning Badge
- **Background**: `#FEF3C7`
- **Text**: `--design-accent-active` (`#92400E`)
- **Uso**: Status de atenção

#### Error Badge
- **Background**: `#FEE2E2`
- **Text**: `#991B1B`
- **Uso**: Status de erro

### Tipografia
- **Família**: DM Sans 400-600, DM Serif Display (títulos)
- **Primária**: `color: var(--design-text-primary)`
- **Secundária**: `color: var(--design-text-secondary)`
- **Titles (H1-H3)**: DM Serif Display, `color: var(--design-header)`

---

## 🎯 Regras de Uso

### 1. **Laranja (Accent) - EXCLUSIVAMENTE CTAs**
```
✅ DO: Botões de ação, links de chamada à ação, ícones de interação
❌ DON'T: Fundos grandes, áreas de leitura, estrutura de navegação
```

### 2. **Verde/Teal (Primary) - Estrutura e Informação**
```
✅ DO: Headers, navegação, sidebars, elementos informativos
❌ DON'T: Distrair da hierarquia de cor primária
```

### 3. **Contraste e Acessibilidade**
- Contraste mínimo 4.5:1 para texto
- Usar `--design-text-primary` em `--design-surface`
- Usar white em `--design-header` e `--design-accent`

### 4. **Espaço em Branco**
- Usar `--design-background` abundantemente para legibilidade
- Padding mínimo em cards: 20px
- Gap entre elementos: 16px (--spacing)

### 5. **Evitar Combinações Ruins**
```
❌ Laranja + Verde puro (contraste baixo) → usar paleta
❌ Texto muito claro em fundo claro → usar text-secondary
❌ Excesso de cores → máximo 3 cores por tela
```

---

## 🔧 Implementação Técnica

### Variáveis CSS (index.html)
```css
:root {
  --design-background:   #F5F5F4;
  --design-surface:      #FFFFFF;
  --design-header:       #1F3D3B;
  --design-primary:      #3C6E71;
  --design-primary-dark: #1F3D3B;
  --design-accent:       #D97706;
  --design-accent-hover: #B45309;
  --design-accent-active:#92400E;
  --design-accent-disabled:#FCD9B6;
  --design-text-primary: #1F2A27;
  --design-text-secondary:#6B7280;
  --design-border:       #E5E7EB;
  
  /* Legacy mapping */
  --cage-blue:   var(--design-header);
  --cage-mid:    var(--design-primary);
  --cage-accent: var(--design-accent);
  --text-primary: var(--design-text-primary);
  --text-secondary: var(--design-text-secondary);
}
```

### Módulos Atualizados
1. ✅ **index.html** - Colors principais, edit mode, buttons
2. ✅ **modules/process-simulator/index.html** - Inline button color
3. ✅ **modules/process-simulator/styles.css** - Tema escuro alinhado

### Compatibilidade
- Legacy CSS variables (`--cage-*`, `--text-*`) mapeadas para novo sistema
- Gradientes atualizados com `#2A5154` → `var(--design-header)`
- Rgba shadows adaptadas para novo header color

---

## 📋 Checklist de Conformidade

- [x] Paleta documentada
- [x] CSS variables definidas
- [x] Botões atualizados
- [x] Headers/Navbars com novas cores
- [x] Badges e estados funcionais
- [x] Process Simulator sincronizado
- [x] Edit mode com novo accent
- [x] Compatibilidade legacy mantida
- [ ] Testes visuais em todos módulos
- [ ] Documentação para futuros devs

---

## 🚀 Próximos Passos

1. **Testar em todos os módulos**
   - Verificar contraste de texto
   - Confirmar hierarchy visual

2. **Validação de Acessibilidade**
   - WCAG 2.1 AA compliance

3. **Atualizar Documentação Interna**
   - Wiki/Confluence com guideline

4. **Treinar Equipe**
   - Code review checklist
   - Design tokens no CI/CD

---

**Última Atualização**: 24/03/2026  
**Responsável**: Felipe Cesar Tourinho  
**Versão**: 1.0
