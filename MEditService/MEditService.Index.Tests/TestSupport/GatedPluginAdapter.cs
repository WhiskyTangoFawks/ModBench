using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>Parks a read just before a named plugin's documents are opened until the test
/// releases it, once per arming, which is what makes progressive loading and write order
/// testable without sleeps.</summary>
internal sealed class GatedPluginAdapter(
    string? gateBefore = null, string? poisonPlugin = null, IPluginAdapter? inner = null)
    : DelegatingPluginAdapter(inner ?? TestAdapters.Mutagen()), IDisposable
{
    private readonly SemaphoreSlim _released = new(0, 1);
    private readonly SemaphoreSlim _arrived = new(0, 1);
    private readonly Lock _gate = new();
    private bool _parkedOnce;

    /// <summary>Every plugin whose documents the Index asked for, in order; a plugin registered warm
    /// is absent.</summary>
    public List<string> Opened { get; } = [];

    public override IPluginDocuments OpenDocuments(
        ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null)
    {
        var pluginName = modPath.ModKey.FileName.ToString();
        if (ShouldParkBefore(pluginName))
        {
            _arrived.Release();
            // Bounded so a regression that stops releasing the gate fails the test rather than
            // hanging the whole suite.
            if (!_released.Wait(TimeSpan.FromSeconds(30)))
                throw new TimeoutException($"gate on {gateBefore} was never released");
        }

        if (pluginName.Equals(poisonPlugin, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"injected open failure for {pluginName}");

        var documents = base.OpenDocuments(modPath, gameRelease, schemas, strings);
        lock (_gate) Opened.Add(pluginName);
        return documents;
    }

    private bool ShouldParkBefore(string pluginName)
    {
        lock (_gate)
        {
            if (gateBefore == null || !pluginName.Equals(gateBefore, StringComparison.OrdinalIgnoreCase)) return false;
            if (_parkedOnce) return false;
            _parkedOnce = true;
            return true;
        }
    }

    public void ParkNextOpenOf(string pluginName)
    {
        lock (_gate)
        {
            gateBefore = pluginName;
            _parkedOnce = false;
        }
    }

    public async Task WaitUntilParkedAsync()
    {
        var arrived = await _arrived.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(arrived, $"the load never reached {gateBefore}");
    }

    public void Release() => _released.Release();

    public int OpenedTotal
    {
        get { lock (_gate) return Opened.Count; }
    }

    public void Dispose()
    {
        _arrived.Dispose();
        _released.Dispose();
    }
}
