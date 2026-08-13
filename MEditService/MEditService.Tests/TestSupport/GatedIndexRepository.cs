using MEditService.Core.Records;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests;

/// <summary>
/// Parks a load just before a named plugin is indexed, and holds it there until the test releases it
/// (#274). This is what makes progressive loading testable without sleeps: the test drives the load
/// to a known point, asserts what is observable *at that instant*, then lets it finish.
///
/// Manual testing is not available for this ticket, so a real load order being watched by a
/// developer is not the fallback it usually is — this gate is the verification.
/// </summary>
/// <param name="poisonPlugin">Optional: a plugin whose indexing throws, so a test can assert that a
/// per-plugin failure is observable at a point where the load is still running.</param>
internal sealed class GatedIndexRepositoryFactory(IRecordRepositoryFactory inner, string gateBefore, string? poisonPlugin = null)
    : IRecordRepositoryFactory, IDisposable
{
    private readonly SemaphoreSlim _released = new(0, 1);
    private readonly SemaphoreSlim _arrived = new(0, 1);

    /// <summary>Every repository this factory has created — one per load, so a test that supersedes
    /// a load can assert on the abandoned one as well as the survivor.</summary>
    public List<GatedIndexRepository> Created { get; } = [];

    public IRecordRepository Create(GameRelease gameRelease)
    {
        // Only the first load is gated: a test that supersedes one load with another wants the
        // second to run unobstructed to completion, and a second park would just be scaffolding to
        // unwind.
        var gate = Created.Count == 0 ? gateBefore : null;
        var repository = new GatedIndexRepository(inner.Create(gameRelease), gate, poisonPlugin, _arrived, _released);
        Created.Add(repository);
        return repository;
    }

    /// <summary>Blocks until the load reaches the gated plugin. Fails rather than hangs if the load
    /// never gets there.</summary>
    public async Task WaitUntilParkedAsync()
    {
        var arrived = await _arrived.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(arrived, $"the load never reached {gateBefore}");
    }

    /// <summary>Lets the parked load continue.</summary>
    public void Release() => _released.Release();

    public void Dispose()
    {
        _arrived.Dispose();
        _released.Dispose();
    }
}

internal sealed class GatedIndexRepository(
    IRecordRepository inner, string? gateBefore, string? poisonPlugin, SemaphoreSlim arrived, SemaphoreSlim released)
    : DelegatingRecordRepository(inner)
{
    /// <summary>Names of the plugins whose indexing actually completed, in order.</summary>
    public List<string> Indexed { get; } = [];
    public bool WinnersComputed { get; private set; }
    public bool Disposed { get; private set; }

    public override void Index(IModGetter pluginMod, int loadOrderIndex, bool participates, string origin)
    {
        var plugin = pluginMod.ModKey.FileName.ToString();
        if (gateBefore != null && plugin.Equals(gateBefore, StringComparison.OrdinalIgnoreCase))
        {
            arrived.Release();
            // Bounded so a regression that stops releasing the gate fails the test rather than
            // hanging the whole suite.
            if (!released.Wait(TimeSpan.FromSeconds(30)))
                throw new TimeoutException($"gate on {gateBefore} was never released");
        }

        if (plugin.Equals(poisonPlugin, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"injected index failure for {plugin}");

        base.Index(pluginMod, loadOrderIndex, participates, origin);
        Indexed.Add(plugin);
    }

    public override void UpdateWinners()
    {
        base.UpdateWinners();
        WinnersComputed = true;
    }

    public override void Dispose()
    {
        Disposed = true;
        base.Dispose();
    }
}
