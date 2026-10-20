import { adminProcedure } from '../_core/trpc';
import { z } from 'zod';
import { fetchWithRetry } from '../utils/retry';

/**
 * ATIS Task Selector API
 * Provides endpoints to fetch tasks from Trello board for the ATIS Phases Analysis page
 * Uses environment variables for Trello API credentials (TRELLO_API_KEY, TRELLO_TOKEN)
 */

/**
 * Query to fetch all tasks from user's Trello boards
 * Returns: Array of tasks with id, name, board, and list info
 */
export const atisTaskSelectorRouter = {
  getTasks: adminProcedure.query(async () => {
    try {
      const apiKey = process.env.TRELLO_API_KEY;
      const token = process.env.TRELLO_TOKEN;

      if (!apiKey || !token) {
        return {
          success: false,
          tasks: [],
          count: 0,
          error: 'Trello credentials not configured',
        };
      }

      // Fetch all boards for the user
      const boardsResponse = await fetchWithRetry(
        `https://api.trello.com/1/members/me/boards?key=${apiKey}&token=${token}`,
        undefined,
        { maxRetries: 3, initialDelayMs: 1000 }
      );

      if (!boardsResponse.ok) {
        throw new Error(`Failed to fetch boards: ${boardsResponse.statusText}`);
      }

      const boards = await boardsResponse.json();

      // Fetch cards from all boards
      const allCards: any[] = [];

      for (const board of boards) {
        try {
          const cardsResponse = await fetchWithRetry(
            `https://api.trello.com/1/boards/${board.id}/cards?key=${apiKey}&token=${token}&filter=open`,
            undefined,
            { maxRetries: 2, initialDelayMs: 500 }
          );

          if (cardsResponse.ok) {
            const cards = await cardsResponse.json();
            allCards.push(
              ...cards.map((card: any) => ({
                id: card.id,
                name: card.name,
                boardId: board.id,
                boardName: board.name,
                listId: card.idList,
                url: card.url,
                due: card.due,
                labels: card.labels,
              }))
            );
          }
        } catch (error) {
          console.error(`Failed to fetch cards from board ${board.id}:`, error);
        }
      }

      return {
        success: true,
        tasks: allCards,
        count: allCards.length,
      };
    } catch (error) {
      console.error('Error fetching ATIS tasks:', error);
      return {
        success: false,
        tasks: [],
        count: 0,
        error: 'Could not load Trello tasks. Retry shortly.',
      };
    }
  }),

  /**
   * Get tasks from a specific board
   */
  getTasksByBoard: adminProcedure
    .input(z.object({ boardId: z.string() }))
    .query(async ({ input }) => {
      try {
        const apiKey = process.env.TRELLO_API_KEY;
        const token = process.env.TRELLO_TOKEN;

        if (!apiKey || !token) {
          return {
            success: false,
            tasks: [],
            count: 0,
            error: 'Trello credentials not configured',
          };
        }

        const cardsResponse = await fetchWithRetry(
          `https://api.trello.com/1/boards/${input.boardId}/cards?key=${apiKey}&token=${token}&filter=open`,
          undefined,
          { maxRetries: 2, initialDelayMs: 500 }
        );

        if (!cardsResponse.ok) {
          throw new Error(`Failed to fetch cards: ${cardsResponse.statusText}`);
        }

        const cards = await cardsResponse.json();

        return {
          success: true,
          tasks: cards.map((card: any) => ({
            id: card.id,
            name: card.name,
            boardId: input.boardId,
            listId: card.idList,
            url: card.url,
            due: card.due,
            labels: card.labels,
          })),
          count: cards.length,
        };
      } catch (error) {
        console.error('Error fetching board tasks:', error);
        return {
          success: false,
          tasks: [],
          count: 0,
          error: 'Could not load Trello tasks. Retry shortly.',
        };
      }
    }),

  /**
   * Search tasks by name across all boards
   */
  searchTasks: adminProcedure
    .input(z.object({ query: z.string() }))
    .query(async ({ input }) => {
      try {
        const apiKey = process.env.TRELLO_API_KEY;
        const token = process.env.TRELLO_TOKEN;

        if (!apiKey || !token) {
          return {
            success: false,
            tasks: [],
            count: 0,
            error: 'Trello credentials not configured',
          };
        }

        // Fetch all boards
        const boardsResponse = await fetchWithRetry(
          `https://api.trello.com/1/members/me/boards?key=${apiKey}&token=${token}`,
          undefined,
          { maxRetries: 3, initialDelayMs: 1000 }
        );

        if (!boardsResponse.ok) {
          throw new Error('Failed to fetch boards');
        }

        const boards = await boardsResponse.json();
        const allCards: any[] = [];
        const query = input.query.toLowerCase();

        for (const board of boards) {
          try {
            const cardsResponse = await fetchWithRetry(
              `https://api.trello.com/1/boards/${board.id}/cards?key=${apiKey}&token=${token}&filter=open`,
              undefined,
              { maxRetries: 2, initialDelayMs: 500 }
            );

            if (cardsResponse.ok) {
              const cards = await cardsResponse.json();
              const filtered = cards
                .filter((card: any) => card.name.toLowerCase().includes(query))
                .map((card: any) => ({
                  id: card.id,
                  name: card.name,
                  boardId: board.id,
                  boardName: board.name,
                  listId: card.idList,
                  url: card.url,
                  due: card.due,
                  labels: card.labels,
                }));

              allCards.push(...filtered);
            }
          } catch (error) {
            console.error(`Failed to search cards in board ${board.id}:`, error);
          }
        }

        return {
          success: true,
          tasks: allCards,
          count: allCards.length,
        };
      } catch (error) {
        console.error('Error searching tasks:', error);
        return {
          success: false,
          tasks: [],
          count: 0,
          error: 'Could not search Trello tasks. Retry shortly.',
        };
      }
    }),
};

export default atisTaskSelectorRouter;
