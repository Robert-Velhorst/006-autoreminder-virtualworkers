/**
 * Conversational Interview Service
 * 
 * Conducts a smart, adaptive interview with the user to understand task goals.
 * Uses AI to probe deeply, ask follow-up questions, and extract true intent.
 */

import type { PreAnalysisResult } from './pre-interview-analysis';
import { validateAnswer, calculateInterviewConfidence, generateFollowUpQuestion, detectLowConfidenceAndGenerateFollowUps, generateSmartFollowUpMessage, type ValidationResult } from './answer-validator';
import { getLLMText, invokeLLM } from '../_core/llm';

export interface InterviewMessage {
  role: 'assistant' | 'user';
  content: string;
  timestamp: Date;
}

export interface InterviewState {
  messages: InterviewMessage[];
  currentTopic: string;
  extractedInfo: {
    goal?: string;
    successCriteria?: string[];
    deadline?: string;
    constraints?: string[];
    people?: Array<{ name: string; role: string }>;
  };
  validations: Array<{
    question: string;
    answer: string;
    validation: ValidationResult;
  }>;
  overallConfidence: number;
  isComplete: boolean;
  lowConfidenceFollowUpsAsked: number;
}

export interface FinalGoal {
  goal: string;
  successCriteria: string[];
  priority: 'urgent' | 'high' | 'normal' | 'low';
  deadline?: string;
  constraints: string[];
  people: Array<{ name: string; role: string }>;
  confidence: number;
}

/**
 * Start a new interview session
 */
export async function startInterview(
  cardName: string,
  preAnalysis: PreAnalysisResult
): Promise<{ state: InterviewState; firstMessage: string }> {
  const state: InterviewState = {
    messages: [],
    currentTopic: 'goal',
    extractedInfo: {},
    validations: [],
    overallConfidence: 0,
    isComplete: false,
    lowConfidenceFollowUpsAsked: 0,
  };

  // Generate opening message based on pre-analysis
  const firstMessage = generateOpeningMessage(cardName, preAnalysis);

  state.messages.push({
    role: 'assistant',
    content: firstMessage,
    timestamp: new Date(),
  });

  return { state, firstMessage };
}

/**
 * Process user response and generate next question
 */
export async function processResponse(
  state: InterviewState,
  userResponse: string,
  preAnalysis: PreAnalysisResult
): Promise<{ nextMessage: string; isComplete: boolean; finalGoal?: FinalGoal }> {
  // Add user message to history
  state.messages.push({
    role: 'user',
    content: userResponse,
    timestamp: new Date(),
  });

  // Validate the user's answer
  const lastQuestion = state.messages[state.messages.length - 2]?.content || '';
  const validation = validateAnswer(userResponse, state.currentTopic as any);
  
  state.validations.push({
    question: lastQuestion,
    answer: userResponse,
    validation,
  });

  // Update overall confidence
  state.overallConfidence = calculateInterviewConfidence(state.validations);

  // Check for low confidence and generate smart follow-ups
  const lowConfidenceResult = detectLowConfidenceAndGenerateFollowUps(validation, 40);
  
  if (lowConfidenceResult.shouldAsk && state.lowConfidenceFollowUpsAsked < 2) {
    // Ask smart follow-up questions for low confidence answers
    const smartFollowUpMessage = generateSmartFollowUpMessage(lowConfidenceResult);
    state.messages.push({
      role: 'assistant',
      content: smartFollowUpMessage,
      timestamp: new Date(),
    });
    state.lowConfidenceFollowUpsAsked++;
    
    return {
      nextMessage: smartFollowUpMessage,
      isComplete: false,
    };
  }

  // If validation failed, ask follow-up question immediately
  if (!validation.isValid) {
    const followUpQuestion = generateFollowUpQuestion(validation);
    if (followUpQuestion) {
      state.messages.push({
        role: 'assistant',
        content: followUpQuestion,
        timestamp: new Date(),
      });
      
      return {
        nextMessage: followUpQuestion,
        isComplete: false,
      };
    }
  }

  // Use AI to analyze response and decide next step
  const aiDecision = await getAINextStep(state, userResponse, preAnalysis);

  if (aiDecision.isComplete) {
    // Interview is done, generate final goal
    const finalGoal = await generateFinalGoal(state, preAnalysis);
    return {
      nextMessage: aiDecision.message,
      isComplete: true,
      finalGoal,
    };
  }

  // Add AI message to history
  state.messages.push({
    role: 'assistant',
    content: aiDecision.message,
    timestamp: new Date(),
  });

  return {
    nextMessage: aiDecision.message,
    isComplete: false,
  };
}

/**
 * Generate opening message based on pre-analysis
 */
function generateOpeningMessage(cardName: string, preAnalysis: PreAnalysisResult): string {
  let message = `Let's clarify the goal for: **${cardName}**\n\n`;

  if (preAnalysis.summary) {
    message += `I've analyzed the card and found:\n${preAnalysis.summary}\n\n`;
  }

  if (preAnalysis.proposedGoal) {
    message += `**My initial understanding:** ${preAnalysis.proposedGoal}\n\n`;
  }

  message += `To make sure I generate the right execution plan, tell me in your own words:\n\n`;
  message += `**What outcome do you want from this task?**`;

  return message;
}

/**
 * Use AI to determine next question
 */
async function getAINextStep(
  state: InterviewState,
  userResponse: string,
  preAnalysis: PreAnalysisResult
): Promise<{ message: string; isComplete: boolean }> {
  const systemPrompt = `You are conducting an interview to understand a task goal. Your job is to:
1. Probe deeply - don't accept vague answers
2. Ask "why?" and "and then what?" to uncover real goals
3. Reflect back understanding to confirm
4. Ask follow-up questions based on responses
5. Keep the conversation natural and conversational
6. ENFORCE SPECIFICITY - reject vague terms like "the client", "ASAP", "follow up"
7. FOCUS ON OUTCOMES - if they say an action, ask what outcome they want

INTERVIEW CONTEXT:
- Card: ${preAnalysis.evidence.keywords.join(', ')}
- Pre-analysis confidence: ${preAnalysis.confidence}%
- Current interview confidence: ${state.overallConfidence}%
- Identified gaps: ${preAnalysis.identifiedGaps.map(g => g.question).join('; ')}

VALIDATION RESULTS:
${state.validations.map(v => `Q: ${v.question}\nA: ${v.answer}\nConfidence: ${v.validation.confidence}%\nIssues: ${v.validation.issues.map(i => i.message).join(', ')}`).join('\n\n')}

CONVERSATION SO FAR:
${state.messages.map(m => `${m.role}: ${m.content}`).join('\n')}

USER JUST SAID: "${userResponse}"

YOUR TASK:
1. Analyze their response - is it vague or specific?
2. If vague (e.g., "send email", "the client", "ASAP"), probe deeper with specific questions
3. If it's an action ("send letter"), ask what outcome they want ("what should happen after the letter?")
4. If specific and outcome-focused, reflect back understanding and move to next topic
5. Only say INTERVIEW_COMPLETE if confidence >= 70% AND all critical topics covered

CRITICAL TOPICS TO COVER:
- What is the real outcome/goal? (not just the action)
- What does success look like? (measurable)
- Who specifically is involved? (no "the client" - actual names)
- What is the specific deadline? (no "ASAP" - actual dates)
- What constraints exist?

CONFIDENCE THRESHOLD:
- Current: ${state.overallConfidence}%
- Required: 70%+
- If below 70%, keep probing for specifics

RESPONSE FORMAT:
If interview is complete AND confidence >= 70%, start with: INTERVIEW_COMPLETE
Otherwise, ask your next question naturally (be conversational, not robotic).`;

  try {
    const response = await invokeLLM({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `User response: "${userResponse}"\n\nWhat should I ask next?` },
      ],
      maxTokens: 500,
    });
    const aiMessage = getLLMText(response) || 'Could you tell me more about that?';

    const isComplete = aiMessage.startsWith('INTERVIEW_COMPLETE');
    const cleanMessage = isComplete ? aiMessage.replace('INTERVIEW_COMPLETE', '').trim() : aiMessage;

    return { message: cleanMessage, isComplete };
  } catch (error) {
    console.error('[Interview] AI error:', error);
    // Fallback to simple follow-up
    return {
      message: 'Could you tell me more about what you want to achieve?',
      isComplete: false,
    };
  }
}

/**
 * Generate final goal from interview conversation
 */
async function generateFinalGoal(
  state: InterviewState,
  preAnalysis: PreAnalysisResult
): Promise<FinalGoal> {
  const systemPrompt = `You are summarizing an interview about a task goal. Extract:
1. The REAL goal (outcome, not just action)
2. Success criteria (what does done look like?)
3. Priority (urgent/high/normal/low)
4. Deadline (if mentioned)
5. Constraints (time, people, resources)
6. People involved and their roles

CONVERSATION:
${state.messages.map(m => `${m.role}: ${m.content}`).join('\n')}

PRE-ANALYSIS:
${preAnalysis.summary}

Return JSON:
{
  "goal": "Clear statement of what we're trying to achieve",
  "successCriteria": ["Criterion 1", "Criterion 2"],
  "priority": "urgent|high|normal|low",
  "deadline": "YYYY-MM-DD or null",
  "constraints": ["Constraint 1", "Constraint 2"],
  "people": [{"name": "Name", "role": "Role"}],
  "confidence": 85
}`;

  try {
    const response = await invokeLLM({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Extract the final goal from this conversation as JSON.' },
      ],
      maxTokens: 800,
      responseFormat: { type: 'json_object' },
    });
    let content = getLLMText(response) || '{}';

    // Remove markdown code blocks if present
    content = content.trim();
    if (content.startsWith('```json')) {
      content = content.slice(7);
    } else if (content.startsWith('```')) {
      content = content.slice(3);
    }
    if (content.endsWith('```')) {
      content = content.slice(0, -3);
    }
    content = content.trim();

    const finalGoal = JSON.parse(content) as FinalGoal;
    return finalGoal;
  } catch (error) {
    console.error('[Interview] Error generating final goal:', error);
    // Fallback
    return {
      goal: preAnalysis.proposedGoal,
      successCriteria: ['Task completed'],
      priority: 'normal',
      constraints: [],
      people: [],
      confidence: 50,
    };
  }
}
