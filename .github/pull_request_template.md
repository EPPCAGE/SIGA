## 📋 Descrição

<!-- Descreva o que foi alterado e por quê -->

## 🔗 Issue / Tarefa relacionada

<!-- Ex: Fixes #123 | Relates to ADO#456 -->

---

## ✅ Checklist do Autor

### 🧪 Testes
- [ ] Testes unitários adicionados/atualizados para as mudanças
- [ ] `npm run test` passa localmente sem erros
- [ ] `npm run test:coverage` executado — cobertura não regrediu

### 🔒 Segurança
- [ ] `npm audit` executado — sem vulnerabilidades HIGH/CRITICAL novas
- [ ] Nenhuma credencial, token ou chave secreta foi incluída no código
- [ ] Inputs do usuário são validados/sanitizados onde necessário

### 🎯 Qualidade de Código
- [ ] Código segue os padrões do projeto
- [ ] Sem `console.log` de debug deixado acidentalmente
- [ ] Sem código comentado/morto sem justificativa
- [ ] Variáveis de ambiente sensíveis usam o grupo de variáveis do pipeline (não hardcoded)

### 📦 Dependências (preencher se package.json foi alterado)
- [ ] Nova dependência revisada (licença compatível, mantida ativamente)
- [ ] `package-lock.json` atualizado via `npm ci` / `npm install`

### 🚀 Deploy
- [ ] Mudanças testadas em ambiente local (http://localhost:5173)
- [ ] Sem breaking changes que afetem dados existentes em produção
- [ ] Migrações de dados necessárias identificadas e documentadas

---

## 📸 Screenshots / Evidência (se aplicável)

<!-- Adicione capturas de tela para mudanças visuais -->

---

## 💬 Contexto adicional para o revisor

<!-- Qualquer informação que ajude o revisor a entender as mudanças -->
