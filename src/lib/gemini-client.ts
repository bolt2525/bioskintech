import axios from 'axios';

const API_ENDPOINT = '/api/internal-bot-api';

export const geminiClient = {
  async analyzeImage(images: File[], prompt: string, context: string = '') {
    try {
      const processedImages = await Promise.all(images.map(async (file) => {
        return new Promise<{data: string, mimeType: string}>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64String = (reader.result as string).split(',')[1];
            resolve({
              data: base64String,
              mimeType: file.type
            });
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }));

      const response = await axios.post(`${API_ENDPOINT}?type=ai&action=diagnosis`, {
        prompt,
        context,
        images: processedImages
      });

      return response.data.result;
    } catch (error: any) {
      console.error('Error analyzing image:', error);
      throw new Error(error.response?.data?.error || error.message || 'Error connecting to AI service');
    }
  },

  async askProtocol(question: string) {
    try {
      const response = await axios.post(`${API_ENDPOINT}?type=ai&action=protocol`, {
        prompt: question
      });

      return response.data.result;
    } catch (error: any) {
      console.error('Error asking protocol:', error);
      throw new Error(error.response?.data?.error || error.message || 'Error connecting to AI service');
    }
  },
  
  async testConnection() {
      return { status: 'Connected to Vercel API' };
  },

  setBaseUrl(url: string) {
      // No-op
  }
};
