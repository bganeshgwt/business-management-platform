import { createContext, useContext } from "react";

// The tasks screens' "here": see TasksScope.jsx.
export const TasksContext = createContext(null);

export default function useTasks() {
  const value = useContext(TasksContext);
  if (!value) throw new Error("useTasks() outside TasksProvider");
  return value;
}
