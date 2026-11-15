using MEditService.RecordIndex;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The record index a writer hands its write to: it keeps each hand, and answers it as <see cref="Answer"/> does.</summary>
public sealed class HandedWrites : IHandedWrites
{
    private readonly List<IReadOnlyList<HandedPlugin>?> _hands = [];

    public Func<Task<string?>> Answer { get; set; } = () => Task.FromResult<string?>(null);

    public IReadOnlyList<IReadOnlyList<HandedPlugin>?> Hands
    {
        get { lock (_hands) return [.. _hands]; }
    }

    public Task<string?> Hold(IReadOnlyList<HandedPlugin>? written, CancellationToken cancel)
    {
        lock (_hands) _hands.Add(written);
        return Answer().WaitAsync(cancel);
    }
}
