const express = require("express");

const app = express();
const PORT = 3000;

// Allow JSON requests
app.use(express.json());

// Store tasks in memory
let tasks = [];

// Home route
app.get("/", (req, res) => {
    res.json({
        message: "Offline Campus Connect server is running"
    });
});

// Get all tasks
app.get("/tasks", (req, res) => {
    res.json(tasks);
});

// Create / synchronize a task
app.post("/tasks", (req, res) => {

    const task = req.body;

    // Validate task
    if (!task || !task.id || !task.text) {
        return res.status(400).json({
            error: "Invalid task"
        });
    }

    // Check whether task already exists
    const existingTask = tasks.find(
        existingTask => existingTask.id === task.id
    );

    // New task
    if (!existingTask) {

        tasks.push(task);

        return res.json({
            success: true,
            conflict: false,
            message: "Task synchronized",
            task: task
        });
    }

    // Incoming task is newer
    if (
        task.updatedAt &&
        (
            !existingTask.updatedAt ||
            task.updatedAt > existingTask.updatedAt
        )
    ) {

        Object.assign(existingTask, task);

        return res.json({
            success: true,
            conflict: true,
            message: "Conflict resolved: newer version kept",
            task: task
        });
    }

    // Server version is newer
    return res.json({
        success: true,
        conflict: true,
        message: "Conflict resolved: server version kept",
        task: existingTask
    });
});

// Delete a task
app.delete("/tasks/:id", (req, res) => {

    const id = Number(req.params.id);

    const taskIndex = tasks.findIndex(
        task => task.id === id
    );

    if (taskIndex === -1) {
        return res.status(404).json({
            error: "Task not found"
        });
    }

    tasks.splice(taskIndex, 1);

    res.json({
        success: true,
        message: "Task deleted"
    });
});

// Start server
app.listen(PORT, () => {
    console.log(
        `Offline Campus Connect server running at http://localhost:${PORT}`
    );
});