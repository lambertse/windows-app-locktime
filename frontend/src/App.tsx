import { HashRouter as BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
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

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="flex min-h-screen bg-[#0e0e10]">
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
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: '#18181b',
              border: '1px solid #2d2d32',
              color: '#fafafa',
            },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
