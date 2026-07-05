import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Calendar, Clock, Tag, User, ArrowRight } from 'lucide-react';

interface BlogCardProps {
  id: string | number;
  title: string;
  slug: string;
  excerpt: string;
  category: 'medico-estetico' | 'tecnico';
  author: string;
  publishedAt: string;
  readTime: number;
  tags: string[];
  image: string;
  featured?: boolean;
}

const BlogCard: React.FC<BlogCardProps> = ({
  title,
  slug,
  excerpt,
  category,
  author,
  publishedAt,
  readTime,
  tags,
  image,
  featured = false
}) => {
  const categoryLabels = {
    'medico-estetico': 'Médico Estético',
    'tecnico': 'Técnico'
  };

  const categoryColors = {
    'medico-estetico': 'bg-[#deb887] text-white',
    'tecnico': 'bg-gray-800 text-white'
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('es-ES', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  return (
    <motion.article 
      whileHover={{ y: -10 }}
      className={`bg-white rounded-2xl overflow-hidden shadow-lg hover:shadow-2xl transition-all duration-300 flex flex-col h-full ${featured ? 'ring-2 ring-[#deb887]' : ''}`}
    >
      {featured && (
        <div className="absolute top-4 left-4 z-10 bg-[#deb887] text-white px-4 py-1.5 rounded-full text-sm font-medium shadow-lg">
          Destacado
        </div>
      )}
      
      {/* Imagen del blog */}
      <div className="relative h-56 overflow-hidden">
        <motion.img
          whileHover={{ scale: 1.1 }}
          transition={{ duration: 0.6 }}
          src={image}
          alt={title}
          className="w-full h-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).src = '/images/logo/logo1.jpg';
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent"></div>
        
        {/* Categoría */}
        <div className={`absolute top-4 right-4 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider shadow-lg ${categoryColors[category]}`}>
          {categoryLabels[category]}
        </div>
      </div>

      {/* Contenido */}
      <div className="p-8 flex flex-col flex-grow">
        {/* Meta info */}
        <div className="flex items-center gap-4 text-xs text-gray-500 mb-4 font-medium uppercase tracking-wide">
          <div className="flex items-center gap-1.5">
            <Calendar size={14} className="text-[#deb887]" />
            {formatDate(publishedAt)}
          </div>
          <div className="flex items-center gap-1.5">
            <Clock size={14} className="text-[#deb887]" />
            {readTime} min lectura
          </div>
        </div>

        {/* Título */}
        <h3 className="text-xl font-bold text-gray-900 mb-3 group-hover:text-[#deb887] transition-colors font-serif leading-tight">
          <Link to={`/blogs/${slug}`} className="hover:text-[#deb887] transition-colors">
            {title}
          </Link>
        </h3>

        {/* Excerpt */}
        <p className="text-gray-600 mb-6 line-clamp-3 leading-relaxed text-sm flex-grow">
          {excerpt}
        </p>

        {/* Tags */}
        <div className="flex flex-wrap gap-2 mb-6">
          {tags.slice(0, 3).map((tag, index) => (
            <span
              key={index}
              className="inline-flex items-center gap-1 bg-gray-50 text-gray-600 px-3 py-1 rounded-full text-xs font-medium border border-gray-100"
            >
              <Tag size={10} className="text-[#deb887]" />
              {tag}
            </span>
          ))}
        </div>

        {/* Footer del card */}
        <div className="pt-6 border-t border-gray-100 flex items-center justify-between mt-auto">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400">
              <User size={14} />
            </div>
            <span className="text-xs font-medium text-gray-500">{author}</span>
          </div>
          
          <Link 
            to={`/blogs/${slug}`}
            className="inline-flex items-center gap-2 text-[#deb887] font-semibold text-sm hover:text-[#c9a677] transition-colors group"
          >
            Leer más
            <ArrowRight size={16} className="transform group-hover:translate-x-1 transition-transform" />
          </Link>
        </div>
      </div>
    </motion.article>
  );
};

export default BlogCard;