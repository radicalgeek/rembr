#!/usr/bin/env node

/**
 * RLM Task Coordination Script
 * Helps manage recursive decomposition workflows with rembr
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class RLMTaskManager {
  constructor() {
    this.currentTaskId = null;
    this.decompositionLevel = 0;
    this.maxDepth = 3;
  }

  /**
   * Generate a unique task ID for the RLM session
   */
  generateTaskId(taskName) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomId = Math.random().toString(36).substr(2, 5);
    return `${taskName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${date}-${randomId}`;
  }

  /**
   * Auto-detect if a task requires RLM decomposition
   */
  shouldDecompose(taskDescription) {
    const decompositionIndicators = [
      // Multiple steps or phases
      /implement.*and.*|create.*with.*|build.*plus/i,
      
      // Cross-cutting concerns  
      /refactor.*|migrate.*|integrate.*|modernize/i,
      
      // Analysis + implementation
      /analyze.*and.*(build|implement|create)|research.*and.*(develop|code)/i,
      
      // Multiple technologies mentioned
      /\b(react|vue|angular).*\b(express|fastify|node).*\b(postgres|mysql|redis)/i,
      
      // Complexity markers
      /multiple.*|several.*|various.*|across.*|throughout/i,
      
      // Scale indicators
      /service.*service|system.*system|component.*component/i
    ];

    return decompositionIndicators.some(pattern => pattern.test(taskDescription));
  }

  /**
   * Extract key concepts for memory retrieval
   */
  extractConcepts(taskDescription) {
    // Remove common words and extract meaningful terms
    const stopWords = ['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
    const words = taskDescription.toLowerCase().split(/\W+/);
    const concepts = words.filter(word => 
      word.length > 2 && 
      !stopWords.includes(word) &&
      !/^\d+$/.test(word)
    );

    // Extract technical terms (frameworks, languages, etc.)
    const techTerms = taskDescription.match(/\b(react|vue|angular|express|fastify|node|postgres|mysql|redis|typescript|javascript|python|api|rest|graphql|auth|oauth|jwt|rate|limit|cache|middleware|service|component|database|migration|test|deploy)\b/gi) || [];
    
    return [...new Set([...concepts.slice(0, 5), ...techTerms.map(t => t.toLowerCase())])];
  }

  /**
   * Generate decomposition suggestions
   */
  suggestDecomposition(taskDescription) {
    const suggestions = [];
    
    // Pattern-based decomposition suggestions
    if (/implement.*rate.*limit/i.test(taskDescription)) {
      suggestions.push(
        "L1-Analysis: Analyze current endpoints and traffic patterns",
        "L1-Design: Design rate limiting strategy with Redis/memory store",
        "L1-Implementation: Implement rate limiting middleware",
        "L1-Testing: Create tests and monitoring for rate limits"
      );
    } else if (/migrate.*to/i.test(taskDescription)) {
      suggestions.push(
        "L1-Assessment: Analyze current architecture and dependencies",
        "L1-Planning: Plan migration strategy and compatibility",
        "L1-Migration: Execute core migration steps",
        "L1-Validation: Test and validate migrated system"
      );
    } else if (/integrate.*service|connect.*system/i.test(taskDescription)) {
      suggestions.push(
        "L1-Discovery: Map integration points and data flow",
        "L1-Auth: Implement authentication and authorization",
        "L1-DataFlow: Build data transformation and APIs",
        "L1-Monitoring: Add logging, metrics, and error handling"
      );
    } else {
      // Generic decomposition
      suggestions.push(
        "L1-Research: Analyze requirements and existing code",
        "L1-Design: Plan architecture and implementation approach", 
        "L1-Core: Implement core functionality",
        "L1-Integration: Handle integration and edge cases"
      );
    }

    return suggestions;
  }

  /**
   * Generate memory search query for context retrieval
   */
  generateContextQuery(concepts, area = null) {
    const baseQuery = concepts.slice(0, 3).join(' ');
    
    if (area) {
      return `${baseQuery} ${area}`;
    }
    
    return baseQuery;
  }

  /**
   * Create a subagent prompt template
   */
  createSubagentPrompt(subtask, concepts, parentTaskId, level = 1) {
    const childTaskId = `${parentTaskId}-L${level}-${subtask.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const contextQuery = this.generateContextQuery(concepts, subtask.split(':')[0]);
    
    return `
## Task
${subtask}

## Context Query for rembr
Use this query to retrieve relevant context before starting:
\`\`\`
search_memory({ 
  query: "${contextQuery}", 
  category: "facts",
  limit: 5 
})
\`\`\`

## Recursive Authority
You may spawn your own subagents using runSubagent if this task requires further decomposition.
- Current level: L${level} (max depth: ${this.maxDepth})
- Parent taskId: ${parentTaskId}
- Your taskId: ${childTaskId}

## Storage Instructions
Store all findings to rembr with:
\`\`\`javascript
store_memory({
  category: "facts",
  content: "Your findings here",
  metadata: { 
    "taskId": "${childTaskId}", 
    "area": "${subtask.split(':')[0].toLowerCase()}", 
    "level": "L${level}",
    "parent": "${parentTaskId}"
  }
})
\`\`\`

## Return Format
Return using this exact structure:

### Summary
[1-2 paragraph summary of what was discovered/accomplished]

### Findings Stored
- Category: facts
- Search query: "${contextQuery} ${subtask.split(':')[0].toLowerCase()}"
- Metadata filter: { "taskId": "${childTaskId}", "area": "${subtask.split(':')[0].toLowerCase()}", "level": "L${level}" }
- Memory count: [number of memories stored]

### Subagents Spawned
- Count: [number of recursive subagents spawned, 0 if none]
- Areas: [list of sub-areas handled by child agents]
- Status: [all complete | some pending | failed]

### Key Points
- [Most important findings for parent context]
- [Implementation details discovered]
- [Blockers or dependencies identified]

### Status
[complete | partial | blocked]
[If partial/blocked, explain what remains]

## Guidelines
- Focus only on: ${subtask}
- Spawn subagents if your task involves 3+ distinct components
- Use hierarchical taskIds for any subagents: ${childTaskId}-L${level+1}-[area]
- Coordinate all recursive results before returning
`;
  }

  /**
   * Print RLM workflow suggestion for GitHub Copilot
   */
  printWorkflowSuggestion(taskDescription) {
    if (!this.shouldDecompose(taskDescription)) {
      console.log("🤖 Task appears simple - standard implementation recommended");
      return;
    }

    console.log("\n🧠 RLM PATTERN DETECTED - Complex task requiring decomposition\n");
    
    const taskName = taskDescription.split(' ').slice(0, 3).join('-');
    const taskId = this.generateTaskId(taskName);
    const concepts = this.extractConcepts(taskDescription);
    const suggestions = this.suggestDecomposition(taskDescription);
    
    console.log(`📋 Generated TaskId: ${taskId}`);
    console.log(`🔍 Key Concepts: ${concepts.join(', ')}`);
    console.log(`🏗️  Suggested Decomposition:`);
    suggestions.forEach((suggestion, i) => {
      console.log(`   ${i + 1}. ${suggestion}`);
    });
    
    console.log(`\n📝 Quick Start Commands:`);
    console.log(`\n1. Retrieve Context:`);
    console.log(`search_memory({ 
  query: "${this.generateContextQuery(concepts)}", 
  limit: 5 
})`);

    console.log(`\n2. Store Session Context:`);
    console.log(`store_memory({
  category: "context",
  content: "${taskDescription}",
  metadata: { "taskId": "${taskId}", "type": "session-start" }
})`);

    console.log(`\n3. Spawn First Subagent:`);
    const firstSubtask = suggestions[0] || "L1-Analysis: Analyze task requirements";
    console.log(`runSubagent({
  description: "${firstSubtask}",
  prompt: \`${this.createSubagentPrompt(firstSubtask, concepts, taskId, 1).substring(0, 200)}...\`
})`);

    console.log(`\n🎯 Remember: Each subagent should use the metadata filter { "taskId": "${taskId}" } to retrieve relevant context`);
    console.log(`📊 Expected token reduction: 45-55% for this complexity level\n`);
  }
}

// CLI Interface
if (require.main === module) {
  const manager = new RLMTaskManager();
  const taskDescription = process.argv.slice(2).join(' ');
  
  if (!taskDescription) {
    console.log("Usage: node rlm-helper.js <task description>");
    console.log("Example: node rlm-helper.js implement rate limiting for payment service with Redis backend");
    process.exit(1);
  }
  
  manager.printWorkflowSuggestion(taskDescription);
}

module.exports = RLMTaskManager;