import { HashRouter as BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { ThemeProvider, useTheme } from './contexts/ThemeContext'
import { TitleBar } from './components/layout/TitleBar'
import { Sidebar } from './components/layout/Sidebar'
import { Dashboard } from './pages/Dashboard'
import { Rules } from './pages/Rules'
import { AddRule } from './pages/AddRule'
import { EditRule } from './pages/EditRule'
import { Stats } from './pages/Stats'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

function AppShell() {
  const { theme } = useTheme()

  return (
    <BrowserRouter>
      <div className="flex flex-col h-screen" style={{ background: 'var(--background)' }}>
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/rules/new" element={<AddRule />} />
            <Route path="/rules/:id/edit" element={<EditRule />} />
            <Route path="/stats" element={<Stats />} />
          </Routes>
        </main>
        </div>
      </div>
      <Toaster
        position="top-right"
        theme={theme}
        toastOptions={{
          style: {
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
          },
        }}
      />
    </BrowserRouter>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppShell />
      </ThemeProvider>
    </QueryClientProvider>
  )
}
