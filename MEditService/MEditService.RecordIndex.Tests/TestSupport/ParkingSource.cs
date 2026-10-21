using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Parks a read in the source adapter's tree lookup until the test releases it: the point
/// where a query holds the Index's reads and has not yet opened a connection on them.</summary>
internal sealed class ParkingSource : DelegatingSourceAdapter, IDisposable
{
    private readonly SemaphoreSlim _released = new(0, 1);
    private readonly SemaphoreSlim _arrived = new(0, 1);
    private int _armed;

    public ParkingSource() : base(TestAdapters.Source())
    {
    }

    public void ParkNextTreeLookup() => Volatile.Write(ref _armed, 1);

    public async Task WaitUntilParkedAsync() => await _arrived.WaitAsync(TimeSpan.FromSeconds(30));

    public void Release() => _released.Release();

    public void Dispose()
    {
        _released.Dispose();
        _arrived.Dispose();
    }

    public override ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release)
    {
        if (Interlocked.Exchange(ref _armed, 0) == 0) return base.TreeOf(plugin, release);
        _arrived.Release();
        if (!_released.Wait(TimeSpan.FromSeconds(30))) throw new TimeoutException("the parked read was never released");
        return base.TreeOf(plugin, release);
    }
}
