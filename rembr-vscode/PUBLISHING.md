# Publishing @rembr/client to npm

**Package**: @rembr/client  
**Version**: 1.0.0  
**Registry**: npm (public scoped package)

## Pre-Publishing Checklist

### 1. npm Account Setup

✅ **Verify npm account**:
```bash
npm whoami
```

✅ **Login if needed**:
```bash
npm login
```

✅ **Verify @rembr scope access**:
```bash
npm access list packages
```

Should show you have access to `@rembr/client`.

### 2. Package Verification

✅ **Test local installation**:
```bash
cd rembr-client
npm pack
# Creates rembr-client-1.0.0.tgz

# Test in another directory
cd /tmp
npm install ~/rembr/rembr-client/rembr-client-1.0.0.tgz
npx rembr help
```

✅ **Check package contents**:
```bash
tar -tzf rembr-client-1.0.0.tgz
```

Should include:
- package.json
- cli.js
- postinstall.js
- setup.js
- templates/ (with all agent configs)
- README.md
- CHANGELOG.md
- LICENSE

✅ **Verify package.json metadata**:
- [x] Name: `@rembr/client`
- [x] Version: `1.0.0`
- [x] Description: Clear and keyword-rich
- [x] Keywords: Includes MCP, AI, RLM, etc.
- [x] Homepage: https://rembr.ai
- [x] Repository: GitHub URL
- [x] License: MIT
- [x] Engines: Node >=18
- [x] Files: Only necessary files included

### 3. Documentation Review

✅ **README.md**:
- [x] Clear installation instructions
- [x] Feature overview
- [x] Setup guide for each tool (VS Code, Cursor, Windsurf, Claude)
- [x] Example usage
- [x] Link to REMBR website

✅ **CHANGELOG.md**:
- [x] v1.0.0 initial release documented
- [x] All features listed
- [x] Pricing tiers documented

✅ **LICENSE**:
- [x] MIT license included

## Publishing Steps

### 1. Dry Run

Test what will be published without actually publishing:

```bash
cd /Users/mark/rembr/rembr-client
npm publish --dry-run
```

Review the output carefully. Should show:
- Package size (should be < 50KB)
- Files included
- No warnings about missing fields

### 2. Publish to npm

```bash
cd /Users/mark/rembr/rembr-client

# Publish as public scoped package
npm publish --access public
```

**Note**: Scoped packages (@rembr/client) are private by default. The `--access public` flag makes it publicly available.

### 3. Verify Publication

✅ **Check on npm**:
```bash
npm info @rembr/client
```

Should show:
- Version: 1.0.0
- Description, keywords, license
- Homepage and repository links
- Install command

✅ **View on npmjs.com**:
Open https://www.npmjs.com/package/@rembr/client

✅ **Test installation**:
```bash
# In a clean directory
mkdir /tmp/test-rembr
cd /tmp/test-rembr
npm init -y
npm install -D @rembr/client

# Test CLI
npx rembr help
npx rembr setup
```

### 4. Git Tagging

After successful publish, tag the release:

```bash
cd /Users/mark/rembr
git add rembr-client/
git commit -m "RELEASE: @rembr/client v1.0.0

- Initial npm publication
- 19 MCP tools for AI memory management
- RLM-optimized search with 4 modes
- Support for VS Code, Cursor, Windsurf, Claude Desktop
- Automatic MCP configuration
- Recursive Analyst agent template

Published to: https://www.npmjs.com/package/@rembr/client"

git tag rembr-client-v1.0.0
git push origin main
git push origin rembr-client-v1.0.0
```

## Post-Publishing Tasks

### 1. Update REMBR Website

Add installation instructions to https://rembr.ai/docs:

```markdown
## Quick Start

Install the client:
\`\`\`bash
npm install -D @rembr/client
\`\`\`

The postinstall script will automatically:
- Add REMBR to your MCP config
- Create agent templates
- Configure tool integrations
```

### 2. Social Media Announcement

**Twitter/X**:
```
🫐 Just shipped: @rembr/client v1.0.0 on npm!

One command to add semantic memory to your AI agents:
npm install -D @rembr/client

✨ 19 MCP tools
🔍 4 search modes (hybrid, semantic, text, phrase)
🤖 Built for RLMs & multi-agent systems
💰 Free tier: 1,000 memories

Perfect for @GitHub Copilot, @cursor_ai, @windsurf_ai

npm: https://www.npmjs.com/package/@rembr/client
Docs: https://rembr.ai/docs

#MCP #AI #RLM #GitHubCopilot
```

**Dev.to / Medium Post**:
Title: "Introducing @rembr/client: One-Command Memory for AI Agents"

Topics:
- Why AI agents need persistent memory
- RLM paradigm and context management
- How REMBR solves task isolation
- Installation and setup guide
- Example: Building a recursive code analyzer

### 3. Community Outreach

**GitHub Discussions**:
- Post in MCP community discussions
- Share in RLM GitHub repo discussions
- Add to awesome-mcp list

**Discord/Slack**:
- MCP community servers
- AI agent development channels
- Share in GitHub Copilot community

### 4. Documentation Updates

**Add to rembr.ai**:
- Installation guide
- Tool-by-tool setup instructions
- Example projects using @rembr/client
- Video walkthrough (optional)

**GitHub README**:
- Badge showing npm version: `[![npm version](https://badge.fury.io/js/%40rembr%2Fclient.svg)](https://www.npmjs.com/package/@rembr/client)`
- Installation command prominently displayed
- Link to npm package

## Troubleshooting

### Issue: "You do not have permission to publish @rembr/client"

**Solution**: 
1. Verify you own the @rembr scope:
   ```bash
   npm owner ls @rembr/client
   ```
2. If not, create the scope:
   ```bash
   npm org create rembr
   ```
3. Or use a different scope you control

### Issue: "npm ERR! 402 Payment Required"

**Solution**: Scoped packages require npm Teams (paid) OR publish as public:
```bash
npm publish --access public
```

### Issue: "Version 1.0.0 already exists"

**Solution**: 
1. Check current version on npm:
   ```bash
   npm info @rembr/client version
   ```
2. Increment version:
   ```bash
   npm version patch  # 1.0.0 → 1.0.1
   npm version minor  # 1.0.0 → 1.1.0
   npm version major  # 1.0.0 → 2.0.0
   ```
3. Publish new version

### Issue: Postinstall script not running

**Solution**: Users can skip with `SKIP_REMBR_SETUP=1 npm install` (documented in README)

## Version Management

### Future Releases

**Patch (1.0.x)**: Bug fixes, typos, minor improvements
```bash
npm version patch
npm publish --access public
git push && git push --tags
```

**Minor (1.x.0)**: New features, backward compatible
```bash
npm version minor
npm publish --access public
git push && git push --tags
```

**Major (x.0.0)**: Breaking changes
```bash
npm version major
npm publish --access public
git push && git push --tags
```

## Monitoring

### Weekly Checks

✅ **Download stats**:
```bash
npm info @rembr/client | grep downloads
```

Or view at: https://npm-stat.com/charts.html?package=@rembr/client

✅ **Issues**:
Monitor GitHub issues for installation problems

✅ **Dependencies**:
```bash
npm outdated
```

(Currently has no dependencies, so nothing to update)

## Success Metrics

### Week 1 Goals
- [ ] 10+ downloads
- [ ] Listed on npmjs.com search for "mcp"
- [ ] No critical issues reported

### Month 1 Goals
- [ ] 100+ downloads
- [ ] Featured in an AI agent tutorial
- [ ] Added to awesome-mcp list
- [ ] Mentioned in MCP/RLM community

### Quarter 1 Goals
- [ ] 1,000+ downloads
- [ ] 5+ GitHub stars on rembr-client repo
- [ ] Integration examples in multiple projects
- [ ] Partnership with an RLM framework

---

**Ready to publish?** Run:
```bash
cd /Users/mark/rembr/rembr-client
npm publish --access public
```

🚀 Ship it!
