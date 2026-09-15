using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests;

/// <summary>Parks a load just before a named plugin is indexed until the test releases it, which is
/// what makes progressive loading testable without sleeps. <paramref name="poisonPlugin"/> makes
/// that plugin's indexing throw.</summary>
internal sealed class GatedIndexRepositoryFactory(IRecordIndexFactory inner, string gateBefore, string? poisonPlugin = null)
    : IRecordIndexFactory, IDisposable
{
    private readonly SemaphoreSlim _released = new(0, 1);
    private readonly SemaphoreSlim _arrived = new(0, 1);

    // One per load, so a test that supersedes a load can assert on the abandoned one too.
    public List<GatedIndexRepository> Created { get; } = [];

    public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null)
    {
        // Only the first load is gated: a test that supersedes one load with another wants the
        // second to run unobstructed to completion, and a second park would just be scaffolding to
        // unwind.
        var gate = Created.Count == 0 ? gateBefore : null;
        var repository = new GatedIndexRepository(inner.Create(gameRelease), gate, poisonPlugin, _arrived, _released);
        Created.Add(repository);
        return repository;
    }

    public IRecordIndex Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence) =>
        inner.Rebuild(gameRelease, instanceRoot, atLeastSequence);

    public async Task WaitUntilParkedAsync()
    {
        var arrived = await _arrived.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(arrived, $"the load never reached {gateBefore}");
    }

    public void Release() => _released.Release();

    public void Dispose()
    {
        _arrived.Dispose();
        _released.Dispose();
    }
}

internal sealed class GatedIndexRepository(
    IRecordIndex inner, string? gateBefore, string? poisonPlugin, SemaphoreSlim arrived, SemaphoreSlim released)
    : DelegatingRecordIndex(inner)
{
    public List<string> Indexed { get; } = [];
    public bool WinnersComputed { get; private set; }
    public bool Disposed { get; private set; }

    public override void Index(
        IPluginDocuments documents, Registration registration, PluginKey key, string? filePath = null)
    {
        var pluginName = key.Name;
        if (gateBefore != null && pluginName.Equals(gateBefore, StringComparison.OrdinalIgnoreCase))
        {
            arrived.Release();
            // Bounded so a regression that stops releasing the gate fails the test rather than
            // hanging the whole suite.
            if (!released.Wait(TimeSpan.FromSeconds(30)))
                throw new TimeoutException($"gate on {gateBefore} was never released");
        }

        if (pluginName.Equals(poisonPlugin, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"injected index failure for {pluginName}");

        base.Index(documents, registration, key, filePath);
        Indexed.Add(pluginName);
    }

    public override void UpdateWinners(IReadOnlyList<RegisteredCopy> participating)
    {
        base.UpdateWinners(participating);
        WinnersComputed = true;
    }

    public override void Dispose()
    {
        Disposed = true;
        base.Dispose();
    }
}
