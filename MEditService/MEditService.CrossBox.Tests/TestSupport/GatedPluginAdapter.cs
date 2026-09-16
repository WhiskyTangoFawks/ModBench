using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.TestSupport;

/// <summary>Forwards every member to the real adapter so a double states only the verb it cares
/// about: these tests want real plugins read with one seam intercepted, not a fake adapter.</summary>
internal abstract class DelegatingPluginAdapter(IPluginAdapter inner) : IPluginAdapter
{
    public virtual IPluginDocuments OpenDocuments(
        ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null) =>
        inner.OpenDocuments(modPath, gameRelease, schemas, strings);

    public IPluginRecordLookup OpenRecordLookup(
        ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        inner.OpenRecordLookup(modPath, gameRelease, schemas);

    public virtual (PluginContent Content, Exception? Unreachable) ReadContent(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null) =>
        inner.ReadContent(modPath, gameRelease, strings);

    public PluginFormIds ReadFormIds(ModPath modPath, GameRelease gameRelease) => inner.ReadFormIds(modPath, gameRelease);

    public LinkAnswers LinkTargets(
        IReadOnlyList<ModPath> loadOrder, GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, IReadOnlyCollection<string> formKeys) =>
        inner.LinkTargets(loadOrder, gameRelease, schemas, formKeys);

    public bool LinksTo(ModPath modPath, GameRelease gameRelease, FormKey target, FormKey? itself) =>
        inner.LinksTo(modPath, gameRelease, target, itself);

    public Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<TreeFile> files, RecordTextCodec codec, GameRelease gameRelease, CancellationToken cancel = default) =>
        inner.ReadTreeAsync(files, codec, gameRelease, cancel);

    public Task WriteFromTreeAsync(IReadOnlyList<TreeFile> files, string destinationPath, CancellationToken cancel = default) =>
        inner.WriteFromTreeAsync(files, destinationPath, cancel);

    public Task<(IReadOnlyList<TreeFile> Files, string? MissingStringsFile)> ReadSourceAsync(
        ModPath modPath, string registeredName, GameRelease gameRelease, PluginStrings strings, CancellationToken cancel = default) =>
        inner.ReadSourceAsync(modPath, registeredName, gameRelease, strings, cancel);

    public Task<IReadOnlyList<TreeFile>> ReadPristineFilesAsync(
        ModPath modPath, GameRelease gameRelease, PluginStrings strings, CancellationToken cancel = default) =>
        inner.ReadPristineFilesAsync(modPath, gameRelease, strings, cancel);

    public IEnumerable<(RecordIdentity Identity, string Text)> RecordDocumentsOf(
        ModPath modPath, GameRelease gameRelease, PluginStrings strings, RecordTextCodec codec,
        IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        inner.RecordDocumentsOf(modPath, gameRelease, strings, codec, schemas);

    public string? DivergenceBetween(ModPath modPath, string recompiledPath, GameRelease gameRelease, PluginStrings strings) =>
        inner.DivergenceBetween(modPath, recompiledPath, gameRelease, strings);

    public Task CreateAndWriteAsync(ModKey modKey, string destinationPath, GameRelease gameRelease, bool smallMaster) =>
        inner.CreateAndWriteAsync(modKey, destinationPath, gameRelease, smallMaster);
}

/// <summary>Parks a reconcile just before a named plugin's documents are opened until the test
/// releases it, once, which is what makes progressive loading testable without sleeps.</summary>
internal sealed class GatedPluginAdapter(
    string? gateBefore = null, string? poisonPlugin = null, IPluginAdapter? inner = null)
    : DelegatingPluginAdapter(inner ?? MutagenPluginAdapter.Instance), IDisposable
{
    private readonly SemaphoreSlim _released = new(0, 1);
    private readonly SemaphoreSlim _arrived = new(0, 1);
    private readonly Lock _gate = new();
    private bool _parkedOnce;

    /// <summary>Every plugin whose documents the Index asked for, in order; a copy registered warm
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
        if (gateBefore == null || !pluginName.Equals(gateBefore, StringComparison.OrdinalIgnoreCase)) return false;
        lock (_gate)
        {
            if (_parkedOnce) return false;
            _parkedOnce = true;
            return true;
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
