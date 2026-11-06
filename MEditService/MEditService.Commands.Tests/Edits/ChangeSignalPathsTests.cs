using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

public sealed class ChangeSignalPathsTests : IDisposable
{
    private const string NamedMod = "NamedMod";
    private const string OtherMod = "OtherMod";

    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly ScratchDirectory _instanceRoot = new("medit-change-signal-paths-");
    private readonly IServiceProvider _service;
    private readonly List<IReadOnlyList<PluginAddress>?> _relayed = [];

    public ChangeSignalPathsTests()
    {
        _service = TestEditService.Over(new LoadOrderHolder(), adapter: new HashingAs("changed"), notifications: _notifications);
        ExternalChanges.Put(
            SnapshotPlugins.Snapshot(_instanceRoot, _instanceRoot, GameRelease.Fallout4, [CompiledPlugin(NamedMod, 0), CompiledPlugin(OtherMod, 1)]),
            _service.GetRequiredService<PutLoadOrderHandler>());
        _service.GetRequiredService<ISourceAdapter>().ChangeSignalled += _relayed.Add;
    }

    public void Dispose() => _instanceRoot.Dispose();

    private string FolderOf(string mod) => Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", mod)).FullName;

    private static string PluginOf(string mod) => $"{mod}.esp";

    private LoadOrderEntry CompiledPlugin(string mod, int line)
    {
        var path = Path.Combine(FolderOf(mod), PluginOf(mod));
        File.WriteAllBytes(path, "the compiled plugin binary"u8.ToArray());
        TestAdapters.Source().Init(FolderOf(mod), [(
            (IReadOnlyList<TreeFile>)[new TreeFile(TreeTampering.HeaderDocumentOf(PluginOf(mod)), "{}"u8.ToArray())],
            new DecompiledPlugin(new PluginAddress(PluginOf(mod), mod), "0"))]);
        return new LoadOrderEntry(PluginOf(mod), path, mod, line, Enabled: true, Winning: true);
    }

    private string PathNamed(string kind) => kind switch
    {
        "plugin file" => Path.Combine(FolderOf(NamedMod), PluginOf(NamedMod)),
        "plugin source" => Path.Combine(FolderOf(NamedMod), TreeTampering.HeaderDocumentOf(PluginOf(NamedMod))),
        "asset" => Path.Combine(FolderOf(NamedMod), "textures", "named.dds"),
        "build file" => Path.Combine(FolderOf(NamedMod), "build.json"),
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null),
    };

    private void Signal(string[] kinds) =>
        _service.GetRequiredService<SignalChangeHandler>().Signal([.. kinds.Select(PathNamed)]);

    private string[] ToldExternalChangeOf() =>
        [.. _notifications.Notifications.OfType<ExternalChangeNotification>().Select(notice => notice.Origin).Order(StringComparer.Ordinal)];

    private void Signal(string kinds) => Signal(kinds.Split(',', StringSplitOptions.RemoveEmptyEntries));

    [Theory]
    [InlineData("plugin file")]
    [InlineData("plugin source")]
    [InlineData("plugin file,asset")]
    public void APathThatTouchesAPlugin_HasTheRecordIndexReReadThatPlugin(string kinds)
    {
        Signal(kinds);

        Assert.Equal([new PluginAddress(PluginOf(NamedMod), NamedMod)], Assert.Single(_relayed));
    }

    [Theory]
    [InlineData("")]
    [InlineData("build file")]
    [InlineData("plugin file,build file")]
    public void NoPath_OrOneReadForPluginsItsAdapterCannotName_HasTheRecordIndexCheckTheDisk_AndEveryModChecked(string kinds)
    {
        Signal(kinds);

        Assert.Null(Assert.Single(_relayed));
        Assert.Equal([NamedMod, OtherMod], ToldExternalChangeOf());
    }

    [Fact]
    public void PathsTheRecordIndexDoesNotRead_ReReadNothing_AndCheckNoMod()
    {
        Signal("asset");

        Assert.Empty(_relayed);
        Assert.Empty(ToldExternalChangeOf());
    }

    [Fact]
    public void APluginFileNamed_ChecksOnlyItsModForAnExternalChange()
    {
        Signal("plugin file");

        Assert.Equal([NamedMod], ToldExternalChangeOf());
    }

    [Fact]
    public void PluginSourceNamed_ChecksNoModForAnExternalChange()
    {
        Signal("plugin source");

        Assert.Empty(ToldExternalChangeOf());
    }

    private sealed class HashingAs(string hash) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override string? HashOf(string pluginPath) => hash;
    }
}
