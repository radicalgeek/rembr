/**
 * Predictive Analytics Dashboard UI
 * Data-driven insights into memory usage, growth, and quality
 * 
 * Features:
 * - Memory growth trend chart (Chart.js line chart)
 * - Category usage distribution (Chart.js pie/bar chart)
 * - Relationship formation likelihood gauge
 * - Quality degradation risk panel
 * - Interactive charts with tooltips
 */

import { renderTemplate, SCRIPT_INCLUDES } from './index.js';

export interface PredictiveAnalyticsData {
  memory_growth_prediction: {
    next_30_days: number;
    growth_rate: number;
    seasonal_patterns: boolean;
  };
  category_usage_prediction: Record<string, number>;
  relationship_formation_likelihood: number;
  quality_degradation_risk: {
    risk_level: 'low' | 'medium' | 'high';
    risk_factors: string[];
    recommendations: string[];
  };
}

/**
 * Render the predictive analytics dashboard
 */
export function renderAnalyticsDashboard(data: PredictiveAnalyticsData): string {
  const dataJson = JSON.stringify(data, null, 2);
  
  // Prepare category data for Chart.js
  const categories = Object.keys(data.category_usage_prediction);
  const categoryValues = Object.values(data.category_usage_prediction);
  const categoryColors = [
    '#6366f1', '#8b5cf6', '#a855f7', '#c084fc', '#e879f9',
    '#4f46e5', '#7c3aed', '#9333ea', '#a21caf', '#86198f',
    '#4338ca', '#6d28d9', '#7e22ce'
  ];

  return renderTemplate({
    title: 'Predictive Analytics',
    subtitle: 'Memory Growth & Quality Insights',
    content: `
      <div class="rembr-card">
        <div class="rembr-card-title">
          <span class="rembr-badge rembr-badge-primary">📊 Analytics</span>
          Predictive Insights Dashboard
        </div>

        <!-- Top-level metrics -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
          <!-- Memory Growth -->
          <div style="background: var(--rembr-bg); padding: 1.5rem; border-radius: 8px; border-left: 4px solid var(--rembr-primary);">
            <div style="font-size: 0.75rem; color: var(--rembr-text-secondary); margin-bottom: 0.5rem;">
              PREDICTED GROWTH (30d)
            </div>
            <div style="font-size: 2rem; font-weight: 600; margin-bottom: 0.25rem;">
              +${data.memory_growth_prediction.next_30_days}
            </div>
            <div style="font-size: 0.875rem; color: var(--rembr-text-secondary);">
              ${(data.memory_growth_prediction.growth_rate * 100).toFixed(1)}% growth rate
              ${data.memory_growth_prediction.seasonal_patterns ? ' • Seasonal patterns detected' : ''}
            </div>
          </div>

          <!-- Relationship Formation -->
          <div style="background: var(--rembr-bg); padding: 1.5rem; border-radius: 8px; border-left: 4px solid var(--rembr-success);">
            <div style="font-size: 0.75rem; color: var(--rembr-text-secondary); margin-bottom: 0.5rem;">
              RELATIONSHIP FORMATION
            </div>
            <div style="font-size: 2rem; font-weight: 600; margin-bottom: 0.25rem;">
              ${(data.relationship_formation_likelihood * 100).toFixed(0)}%
            </div>
            <div style="font-size: 0.875rem; color: var(--rembr-text-secondary);">
              ${getLikelihoodLabel(data.relationship_formation_likelihood)}
            </div>
          </div>

          <!-- Quality Risk -->
          <div style="background: var(--rembr-bg); padding: 1.5rem; border-radius: 8px; border-left: 4px solid ${getRiskColor(data.quality_degradation_risk.risk_level)};">
            <div style="font-size: 0.75rem; color: var(--rembr-text-secondary); margin-bottom: 0.5rem;">
              QUALITY DEGRADATION RISK
            </div>
            <div style="font-size: 2rem; font-weight: 600; margin-bottom: 0.25rem;">
              <span class="rembr-badge rembr-badge-${getRiskBadgeClass(data.quality_degradation_risk.risk_level)}" style="font-size: 1.25rem;">
                ${data.quality_degradation_risk.risk_level.toUpperCase()}
              </span>
            </div>
            <div style="font-size: 0.875rem; color: var(--rembr-text-secondary);">
              ${data.quality_degradation_risk.risk_factors.length} risk factor${data.quality_degradation_risk.risk_factors.length !== 1 ? 's' : ''} identified
            </div>
          </div>
        </div>

        <!-- Charts Row -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem;">
          <!-- Memory Growth Chart -->
          <div style="background: var(--rembr-bg); padding: 1.5rem; border-radius: 8px;">
            <div style="font-weight: 600; margin-bottom: 1rem; font-size: 1rem;">Memory Growth Projection</div>
            <canvas id="growth-chart" width="400" height="300"></canvas>
          </div>

          <!-- Category Usage Chart -->
          <div style="background: var(--rembr-bg); padding: 1.5rem; border-radius: 8px;">
            <div style="font-weight: 600; margin-bottom: 1rem; font-size: 1rem;">Category Usage Distribution</div>
            <canvas id="category-chart" width="400" height="300"></canvas>
          </div>
        </div>

        <!-- Relationship Likelihood Gauge -->
        <div style="background: var(--rembr-bg); padding: 1.5rem; border-radius: 8px; margin-bottom: 1.5rem;">
          <div style="font-weight: 600; margin-bottom: 1rem; font-size: 1rem;">Relationship Formation Likelihood</div>
          <div style="position: relative; width: 100%; max-width: 600px; margin: 0 auto;">
            <div style="height: 40px; background: linear-gradient(to right, var(--rembr-error) 0%, var(--rembr-warning) 50%, var(--rembr-success) 100%); border-radius: 20px; position: relative; overflow: hidden;">
              <div style="position: absolute; left: ${data.relationship_formation_likelihood * 100}%; top: -10px; transform: translateX(-50%); width: 4px; height: 60px; background: white; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);"></div>
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: 0.75rem; color: var(--rembr-text-secondary);">
              <span>Low</span>
              <span>Medium</span>
              <span>High</span>
            </div>
          </div>
          <div style="text-align: center; margin-top: 1rem; font-size: 0.875rem; color: var(--rembr-text-secondary);">
            ${getLikelihoodExplanation(data.relationship_formation_likelihood)}
          </div>
        </div>

        <!-- Quality Risk Panel -->
        ${data.quality_degradation_risk.risk_factors.length > 0 ? `
          <div style="background: var(--rembr-bg); padding: 1.5rem; border-radius: 8px; border-left: 4px solid ${getRiskColor(data.quality_degradation_risk.risk_level)};">
            <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;">
              <span style="font-size: 1.5rem;">${getRiskIcon(data.quality_degradation_risk.risk_level)}</span>
              <div>
                <div style="font-weight: 600; font-size: 1rem;">Quality Degradation Risk Factors</div>
                <div style="font-size: 0.875rem; color: var(--rembr-text-secondary);">
                  ${data.quality_degradation_risk.risk_level.charAt(0).toUpperCase() + data.quality_degradation_risk.risk_level.slice(1)} risk level
                </div>
              </div>
            </div>

            <div style="margin-bottom: 1.5rem;">
              <div style="font-weight: 600; margin-bottom: 0.75rem; font-size: 0.875rem;">Risk Factors:</div>
              <ul style="list-style: none; padding: 0; margin: 0;">
                ${data.quality_degradation_risk.risk_factors.map(factor => `
                  <li style="padding: 0.75rem; background: var(--rembr-bg-secondary); margin-bottom: 0.5rem; border-radius: 6px; font-size: 0.875rem; display: flex; align-items: start; gap: 0.5rem;">
                    <span style="color: ${getRiskColor(data.quality_degradation_risk.risk_level)};">⚠️</span>
                    <span>${escapeHtml(factor)}</span>
                  </li>
                `).join('')}
              </ul>
            </div>

            ${data.quality_degradation_risk.recommendations.length > 0 ? `
              <div>
                <div style="font-weight: 600; margin-bottom: 0.75rem; font-size: 0.875rem;">Recommendations:</div>
                <ul style="list-style: none; padding: 0; margin: 0;">
                  ${data.quality_degradation_risk.recommendations.map(rec => `
                    <li style="padding: 0.75rem; background: var(--rembr-bg-secondary); margin-bottom: 0.5rem; border-radius: 6px; font-size: 0.875rem; display: flex; align-items: start; gap: 0.5rem;">
                      <span style="color: var(--rembr-success);">💡</span>
                      <span>${escapeHtml(rec)}</span>
                    </li>
                  `).join('')}
                </ul>
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>

      <!-- Insights Panel -->
      <div class="rembr-card">
        <div class="rembr-card-title">Key Insights</div>
        <div style="display: grid; gap: 1rem;">
          ${generateInsights(data).map(insight => `
            <div style="padding: 1rem; background: var(--rembr-bg); border-radius: 6px; border-left: 3px solid ${insight.color};">
              <div style="display: flex; align-items: start; gap: 0.75rem;">
                <span style="font-size: 1.25rem;">${insight.icon}</span>
                <div style="flex: 1;">
                  <div style="font-weight: 600; margin-bottom: 0.25rem; font-size: 0.875rem;">${insight.title}</div>
                  <div style="color: var(--rembr-text-secondary); font-size: 0.875rem;">${insight.description}</div>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `,
    extraHead: SCRIPT_INCLUDES.chartjs,
    extraScripts: `
      <script>
        const data = ${dataJson};

        // Memory Growth Chart
        const growthCtx = document.getElementById('growth-chart').getContext('2d');
        const today = new Date();
        const dates = Array.from({ length: 31 }, (_, i) => {
          const d = new Date(today);
          d.setDate(d.getDate() + i);
          return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        });
        
        // Simulate historical + predicted growth
        const currentMemories = 100; // Placeholder - would come from actual data
        const growthRate = data.memory_growth_prediction.growth_rate;
        const values = dates.map((_, i) => {
          const baseGrowth = currentMemories + (currentMemories * growthRate * (i / 30));
          // Add seasonal variation if detected
          const seasonal = data.memory_growth_prediction.seasonal_patterns 
            ? Math.sin(i / 5) * (currentMemories * 0.05)
            : 0;
          return Math.round(baseGrowth + seasonal);
        });

        new Chart(growthCtx, {
          type: 'line',
          data: {
            labels: dates,
            datasets: [{
              label: 'Predicted Memory Count',
              data: values,
              borderColor: 'rgb(99, 102, 241)',
              backgroundColor: 'rgba(99, 102, 241, 0.1)',
              tension: 0.4,
              fill: true
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                display: false
              },
              tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                titleColor: '#e2e8f0',
                bodyColor: '#cbd5e1',
                borderColor: '#475569',
                borderWidth: 1,
                padding: 12,
                displayColors: false
              }
            },
            scales: {
              y: {
                beginAtZero: false,
                ticks: { color: '#94a3b8' },
                grid: { color: 'rgba(148, 163, 184, 0.1)' }
              },
              x: {
                ticks: { 
                  color: '#94a3b8',
                  maxRotation: 45,
                  minRotation: 45
                },
                grid: { color: 'rgba(148, 163, 184, 0.1)' }
              }
            }
          }
        });

        // Category Usage Chart
        const categoryCtx = document.getElementById('category-chart').getContext('2d');
        const categories = ${JSON.stringify(categories)};
        const categoryValues = ${JSON.stringify(categoryValues)};
        const categoryColors = ${JSON.stringify(categoryColors)};

        new Chart(categoryCtx, {
          type: 'doughnut',
          data: {
            labels: categories.map(c => c.charAt(0).toUpperCase() + c.slice(1)),
            datasets: [{
              data: categoryValues.map(v => Math.round(v * 100)),
              backgroundColor: categoryColors,
              borderWidth: 2,
              borderColor: '#0f172a'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'right',
                labels: {
                  color: '#cbd5e1',
                  padding: 12,
                  font: { size: 11 }
                }
              },
              tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                titleColor: '#e2e8f0',
                bodyColor: '#cbd5e1',
                borderColor: '#475569',
                borderWidth: 1,
                padding: 12,
                callbacks: {
                  label: function(context) {
                    return context.label + ': ' + context.parsed + '%';
                  }
                }
              }
            }
          }
        });
      </script>
    `,
  });
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function getRiskColor(level: string): string {
  const colors: Record<string, string> = {
    high: 'var(--rembr-error)',
    medium: 'var(--rembr-warning)',
    low: 'var(--rembr-success)'
  };
  return colors[level] || 'var(--rembr-text-secondary)';
}

function getRiskBadgeClass(level: string): string {
  const classes: Record<string, string> = {
    high: 'error',
    medium: 'warning',
    low: 'success'
  };
  return classes[level] || 'primary';
}

function getRiskIcon(level: string): string {
  const icons: Record<string, string> = {
    high: '🔴',
    medium: '🟡',
    low: '🟢'
  };
  return icons[level] || '⚪';
}

function getLikelihoodLabel(likelihood: number): string {
  if (likelihood >= 0.8) return 'Very High Likelihood';
  if (likelihood >= 0.6) return 'High Likelihood';
  if (likelihood >= 0.4) return 'Moderate Likelihood';
  if (likelihood >= 0.2) return 'Low Likelihood';
  return 'Very Low Likelihood';
}

function getLikelihoodExplanation(likelihood: number): string {
  if (likelihood >= 0.8) {
    return 'Your memories are highly interconnected. New relationships form frequently as you add related content.';
  }
  if (likelihood >= 0.6) {
    return 'Good memory connectivity. Related memories are likely to form meaningful relationships.';
  }
  if (likelihood >= 0.4) {
    return 'Moderate relationship formation. Consider adding more context to strengthen connections.';
  }
  if (likelihood >= 0.2) {
    return 'Low relationship formation. Your memories may be too isolated or lack common themes.';
  }
  return 'Very few relationships forming. Consider organizing memories by project or topic to improve connectivity.';
}

function generateInsights(data: PredictiveAnalyticsData): Array<{icon: string, title: string, description: string, color: string}> {
  const insights = [];

  // Growth insight
  if (data.memory_growth_prediction.growth_rate > 0.5) {
    insights.push({
      icon: '📈',
      title: 'Rapid Memory Growth',
      description: `You're adding memories at ${(data.memory_growth_prediction.growth_rate * 100).toFixed(0)}% of your current rate. Consider periodic cleanup to maintain quality.`,
      color: 'var(--rembr-primary)'
    });
  } else if (data.memory_growth_prediction.growth_rate < 0.1) {
    insights.push({
      icon: '📉',
      title: 'Slow Memory Growth',
      description: 'Low activity detected. Regular updates help maintain context and improve recall accuracy.',
      color: 'var(--rembr-warning)'
    });
  }

  // Seasonal patterns
  if (data.memory_growth_prediction.seasonal_patterns) {
    insights.push({
      icon: '🔄',
      title: 'Seasonal Patterns Detected',
      description: 'Your memory usage shows recurring patterns. This is normal for work/project-based workflows.',
      color: 'var(--rembr-info)'
    });
  }

  // Category distribution
  const categoryEntries = Object.entries(data.category_usage_prediction);
  const topCategory = categoryEntries.reduce((max, curr) => curr[1] > max[1] ? curr : max, categoryEntries[0]);
  if (topCategory && topCategory[1] > 0.4) {
    insights.push({
      icon: '📊',
      title: 'Category Concentration',
      description: `${Math.round(topCategory[1] * 100)}% of your memories are "${topCategory[0]}". Consider diversifying to improve cross-category insights.`,
      color: 'var(--rembr-success)'
    });
  }

  // Relationship formation
  if (data.relationship_formation_likelihood < 0.3) {
    insights.push({
      icon: '🔗',
      title: 'Low Relationship Formation',
      description: 'Memories are not connecting well. Try adding more context or using consistent terminology.',
      color: 'var(--rembr-warning)'
    });
  }

  return insights;
}
