using System.Collections.Concurrent;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>Holds every task queued to it until the test runs them, so a background task's start
/// is ordered against the test's own steps rather than raced.</summary>
internal sealed class HeldBackScheduler : TaskScheduler
{
    private readonly ConcurrentQueue<Task> _held = new();

    internal void RunHeldBack()
    {
        while (_held.TryDequeue(out var task)) TryExecuteTask(task);
    }

    protected override void QueueTask(Task task) => _held.Enqueue(task);

    protected override bool TryExecuteTaskInline(Task task, bool taskWasPreviouslyQueued) => false;

    protected override IEnumerable<Task> GetScheduledTasks() => [.. _held];
}
