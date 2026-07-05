import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    // Load data
    const dataDir = path.join(process.cwd(), 'data');
    const productsPath = path.join(dataDir, 'products.json');
    const servicesPath = path.join(dataDir, 'services.json');
    
    // Blog paths
    const blogsDir = path.join(process.cwd(), 'src', 'data', 'blogs');
    const blogsIndexPath = path.join(blogsDir, 'index.json');

    let products = [];
    let services = [];
    let blogs = [];

    // Static Pages Definition
    const staticPages = [
      { name: 'Agenda / Reserva', type: 'page', description: 'Agenda tu cita médica o estética', url: '/appointment', keywords: ['agenda', 'reserva', 'cita', 'turno'] },
      { name: 'Contacto / Ubicación', type: 'page', description: 'Información de contacto y ubicación', url: '/contact', keywords: ['contacto', 'ubicacion', 'direccion', 'telefono'] },
      { name: 'Nosotros', type: 'page', description: 'Conoce a nuestro equipo y la Dra. Daniela Creamer', url: '/about', keywords: ['nosotros', 'equipo', 'doctora'] },
      { name: 'Blog', type: 'page', description: 'Artículos sobre salud y estética', url: '/blogs', keywords: ['blog', 'articulos'] },
      { name: 'Resultados', type: 'page', description: 'Galería de resultados de tratamientos', url: '/results', keywords: ['resultados', 'antes', 'despues'] },
      { name: 'Diagnóstico', type: 'page', description: 'Realiza un diagnóstico de piel en línea', url: '/diagnosis', keywords: ['diagnostico', 'test'] },
    ];

    if (fs.existsSync(productsPath)) {
      const productsData = fs.readFileSync(productsPath, 'utf8');
      products = JSON.parse(productsData).map(p => ({
        type: 'product',
        name: p.name,
        description: p.shortDescription,
        category: p.category,
        price: p.price,
        url: `/products/${p.name.toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/₂/g, '2').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')}`
      }));
    }

    if (fs.existsSync(servicesPath)) {
      const servicesData = fs.readFileSync(servicesPath, 'utf8');
      services = JSON.parse(servicesData).map(s => ({
        type: 'service',
        name: s.title,
        description: s.shortDescription,
        category: s.category,
        price: s.price,
        url: `/services#${s.id || s.title.toLowerCase().replace(/ /g, '-')}`
      }));
    }

    // Load Blogs from JSON Files
    if (fs.existsSync(blogsIndexPath)) {
      try {
        const indexContent = fs.readFileSync(blogsIndexPath, 'utf8');
        const indexData = JSON.parse(indexContent);
        
        if (indexData.blogs && Array.isArray(indexData.blogs)) {
          // Limit to 20 most recent blogs to save processing/tokens
          const recentBlogs = indexData.blogs.slice(0, 20);
          
          for (const blogMeta of recentBlogs) {
            if (blogMeta.paths && blogMeta.paths.blog) {
              const blogPath = path.join(process.cwd(), blogMeta.paths.blog);
              if (fs.existsSync(blogPath)) {
                const blogContent = fs.readFileSync(blogPath, 'utf8');
                const fullBlog = JSON.parse(blogContent);
                
                blogs.push({
                  type: 'blog',
                  name: fullBlog.title,
                  description: fullBlog.excerpt,
                  category: fullBlog.category,
                  url: `/blogs/${fullBlog.slug}`
                });
              }
            }
          }
        }
      } catch (blogError) {
        console.error('Error reading blogs JSON:', blogError);
      }
    } else {
      // Fallback: Read individual JSON files if index doesn't exist
      try {
        if (fs.existsSync(blogsDir)) {
          const files = fs.readdirSync(blogsDir);
          const jsonFiles = files.filter(file => file.endsWith('.json') && file !== 'index.json');
          
          for (const file of jsonFiles.slice(0, 20)) {
            const blogPath = path.join(blogsDir, file);
            const content = fs.readFileSync(blogPath, 'utf8');
            const blogData = JSON.parse(content);
            
            blogs.push({
              type: 'blog',
              name: blogData.title,
              description: blogData.excerpt,
              category: blogData.category,
              url: `/blogs/${blogData.slug || file.replace('.json', '')}`
            });
          }
        }
      } catch (fallbackError) {
        console.error('Error reading fallback blogs:', fallbackError);
      }
    }

    // Combine data for context (limit to essential info to save tokens)
    const contextData = [
      ...staticPages,
      ...products,
      ...services,
      ...blogs
    ];

    // Create prompt
    const prompt = `
      Eres un asistente de búsqueda inteligente para la clínica estética BIOSKIN.
      El usuario está buscando: "${query}"
      
      Aquí tienes la lista de elementos disponibles (Productos, Servicios, Páginas, Blogs):
      ${JSON.stringify(contextData)}
      
      Tu tarea es:
      1. Identificar la intención del usuario.
      2. Encontrar los elementos más relevantes (máximo 5).
      3. Si la búsqueda es una pregunta, intenta responderla usando la información de las descripciones.
      
      Responde SOLAMENTE con un objeto JSON con este formato:
      {
        "results": [
          { "name": "Nombre", "type": "product/service/page/blog", "description": "Breve descripción", "url": "url" }
        ],
        "answer": "Respuesta corta y amable si aplica, o null si es solo búsqueda",
        "suggestion": "Sugerencia de búsqueda si no hay resultados claros"
      }
    `;

    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash",
        generationConfig: {
            responseMimeType: "application/json"
        }
    });

    const result = await model.generateContent(prompt);
    const responseContent = result.response.text();
    const parsedResponse = JSON.parse(responseContent);

    res.status(200).json(parsedResponse);

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}
