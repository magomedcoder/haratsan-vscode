package main

type Server struct {
	Port int
}

func NewServer(port int) *Server {
	return &Server{
		Port: port,
	}
}

func (s *Server) Listen() error {
	return nil
}
