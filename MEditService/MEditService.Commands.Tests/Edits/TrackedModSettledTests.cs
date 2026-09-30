using System.Security.Cryptography;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

/// <summary>What the watcher calls when a tracked mod settles or loads (ADR-0003 invariant 3): each
/// tracked plugin's bytes against what Modbench last wrote, and the mod's untracked plugins, told
/// through the port and kept nowhere.</summary>
public sealed class TrackedModSettledTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string Origin = "TestMod";

    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-settled-").FullName;

    private TrackedModSettled Settled => TestEditService.Settled(_notifications);

    private string ModFolder => Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;

    public void Dispose()
    {
        try { Directory.Delete(_instanceRoot, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    private LoadOrderSnapshot WithPlugins(params (string Name, byte[] Bytes)[] plugins)
    {
        foreach (var (name, bytes) in plugins) File.WriteAllBytes(Path.Combine(ModFolder, name), bytes);
        return new LoadOrderSnapshot(_instanceRoot, _instanceRoot, GameRelease.Fallout4,
            [.. plugins.Select((plugin, slot) => new RegisteredPlugin(
                plugin.Name, Origin, Path.Combine(ModFolder, plugin.Name), slot, Enabled: true, Winning: true))]);
    }

    private static string Sha256(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    // The commit trailers spell a hash upper-cased.
    private static string TrailerHash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    // Track as the Source adapter records it: a baseline whose trailer names the bytes it was taken from.
    private void Track(params (string Plugin, byte[] Bytes)[] plugins) =>
        SourceRepository.Track(ModFolder, SourcePreset.Edits, [.. plugins.Select(p => (
            (IReadOnlyList<TreeFile>)[new TreeFile($"source/{p.Plugin}/npc_/{p.Plugin}/000001.json", "{}"u8.ToArray())],
            new BaselineTrailers(p.Plugin, null, TrailerHash(p.Bytes))))]);

    private ExternalChangeNotification TheExternalChange() =>
        Assert.Single(_notifications.Notifications.OfType<ExternalChangeNotification>());

    [Fact]
    public void ASettle_NamesATrackedPlugin_WithTheStateOfItsBytes_WhenTheyDifferFromWhatModbenchLastWrote()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var changed = "changed-by-xedit"u8.ToArray();
        WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        var loadOrder = WithPlugins((PluginName, changed));

        Settled.Handle(loadOrder, ModFolder);

        var notice = TheExternalChange();
        Assert.Equal(Origin, notice.Origin);
        Assert.Equal([new ChangedPlugin(PluginName, Sha256(changed))], notice.Plugins);
    }

    [Fact]
    public async Task ASettle_NamesNoPlugin_ForTheBinaryARealCompileJustWrote()
    {
        using var mod = SourceEditFixture.Tracked();
        mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);
        var result = await CompileServices.Over(mod.LoadOrder).CompileAsync(mod.Plugin);
        Assert.True(result.Succeeded, result.RefusalReason);

        Settled.Handle(mod.LoadOrder, mod.ModFolder);

        var notice = Assert.IsType<ExternalChangeNotification>(Assert.Single(_notifications.Notifications));
        Assert.Equal(SourceEditFixture.ModFolderOrigin, notice.Origin);
        Assert.Empty(notice.Plugins);
    }

    [Fact]
    public void ASettle_NamesATrackedPluginThatCannotBeRead_WithNoState()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        File.Delete(Path.Combine(ModFolder, PluginName));

        Settled.Handle(loadOrder, ModFolder);

        Assert.Equal([new ChangedPlugin(PluginName, null)], TheExternalChange().Plugins);
    }

    // ADR-0003, Derived tactical observations: a missing ref counts as a change, and Modbench never
    // guesses.
    [Fact]
    public void ASettle_NamesATrackedPlugin_WhoseLastWriteIsGone()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        GitProbe.Run(Path.Combine(ModFolder, ".git"), ModFolder, "update-ref", "-d", SourceRepository.LastCompileRef(PluginName));

        Settled.Handle(loadOrder, ModFolder);

        Assert.Equal([new ChangedPlugin(PluginName, Sha256(tracked))], TheExternalChange().Plugins);
    }

    [Fact]
    public void ASettle_NamesTheModsUntrackedPlugins_ApartFromItsChangedOnes()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, tracked), ("Untracked.esp", "never tracked"u8.ToArray()));
        Track((PluginName, tracked));

        Settled.Handle(loadOrder, ModFolder);

        Assert.Empty(TheExternalChange().Plugins);
        var untracked = Assert.Single(_notifications.Notifications.OfType<UntrackedPluginsNotification>());
        Assert.Equal(Origin, untracked.Origin);
        Assert.Equal(["Untracked.esp"], untracked.Plugins);
    }

    // Git shows every tracked file but the binary, so a settle compares the binaries alone.
    [Fact]
    public void ASettle_NamesNoPlugin_ForAChangedTrackedFileOrMetaIni()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, tracked));
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=1.0.0\n");
        File.WriteAllText(Path.Combine(ModFolder, ".gitignore"), "*.esp\n");
        Track((PluginName, tracked));
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=2.0.0\n");
        File.WriteAllText(Path.Combine(ModFolder, ".gitignore"), "*.esp\n*.esm\n");

        Settled.Handle(loadOrder, ModFolder);

        Assert.Equal([], TheExternalChange().Plugins);
    }

    // plugins.md, A row: "changed outside Modbench" needs the plugin tracked, so a mod whose
    // repository went clears what its last settle named.
    [Fact]
    public void ASettle_NamesNoPlugin_ForAnUntrackedFolder()
    {
        var loadOrder = WithPlugins((PluginName, "anything"u8.ToArray()));

        Settled.Handle(loadOrder, ModFolder);

        var notice = Assert.IsType<ExternalChangeNotification>(Assert.Single(_notifications.Notifications));
        Assert.Equal(Origin, notice.Origin);
        Assert.Empty(notice.Plugins);
    }

    // ADR-0003 invariant 3: Modbench keeps nothing about the change.
    [Fact]
    public void ASettle_WritesNothing_IntoTheMod()
    {
        var tracked = "the tracked binary"u8.ToArray();
        WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        var loadOrder = WithPlugins((PluginName, "changed-by-xedit"u8.ToArray()));
        var before = FilesUnder(ModFolder);

        Settled.Handle(loadOrder, ModFolder);

        Assert.Single(TheExternalChange().Plugins);
        Assert.Equal(before, FilesUnder(ModFolder));
    }

    // ADR-0015 invariant 2: a restart and a live change are one call, so over the same bytes they
    // tell the same.
    [Fact]
    public void ASecondSettle_OverTheSameBytes_TellsTheSame()
    {
        var tracked = "the tracked binary"u8.ToArray();
        WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        var loadOrder = WithPlugins((PluginName, "changed-by-xedit"u8.ToArray()));

        Settled.Handle(loadOrder, ModFolder);
        Settled.Handle(loadOrder, ModFolder);

        var notices = _notifications.Notifications.OfType<ExternalChangeNotification>().ToList();
        Assert.Equal(2, notices.Count);
        Assert.Equal(notices[0].Origin, notices[1].Origin);
        Assert.Equal(notices[0].Plugins, notices[1].Plugins);
    }

    // plugins.md, Compile, story 5: a compile records what it writes before it writes it.
    [Fact]
    public void ASettle_NamesNoPlugin_WhenAnInterruptedCompileLeftTheOldBinary()
    {
        var old = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Track((PluginName, old));
        SourceRepository.ParkCompileSnapshot(ModFolder, PluginName, TrailerHash("the compiled binary"u8.ToArray()));

        Settled.Handle(loadOrder, ModFolder);

        Assert.Empty(TheExternalChange().Plugins);
    }

    [Fact]
    public void ASettle_NamesNoPlugin_WhenTwoInterruptedCompilesInARowLeftTheOldBinary()
    {
        var old = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Track((PluginName, old));
        SourceRepository.ParkCompileSnapshot(ModFolder, PluginName, TrailerHash("the first compile"u8.ToArray()));
        SourceRepository.ParkCompileSnapshot(ModFolder, PluginName, TrailerHash("the second compile"u8.ToArray()));

        Settled.Handle(loadOrder, ModFolder);

        Assert.Empty(TheExternalChange().Plugins);
    }

    [Fact]
    public void ASettle_NamesNoPlugin_WhenAnInterruptedCompileLeftTheNewBinary()
    {
        var old = "the tracked binary"u8.ToArray();
        var compiled = "the compiled binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Track((PluginName, old));
        SourceRepository.ParkCompileSnapshot(ModFolder, PluginName, TrailerHash(compiled));
        File.WriteAllBytes(Path.Combine(ModFolder, PluginName), compiled);

        Settled.Handle(loadOrder, ModFolder);

        Assert.Empty(TheExternalChange().Plugins);
    }

    // ADR-0003 invariant 3: once the new binary has landed, it alone is what Modbench last wrote.
    [Fact]
    public async Task ASettle_NamesAPlugin_WhoseBinaryWasPutBackToTheOneBeforeALandedCompile()
    {
        using var mod = SourceEditFixture.Tracked();
        var pluginPath = mod.LoadOrder.Plugin(mod.Plugin)?.Path ?? throw new InvalidOperationException("Expected the fixture's plugin in its load order.");
        var before = File.ReadAllBytes(pluginPath);
        mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);
        var result = await CompileServices.Over(mod.LoadOrder).CompileAsync(mod.Plugin);
        Assert.True(result.Succeeded, result.RefusalReason);
        File.WriteAllBytes(pluginPath, before);

        Settled.Handle(mod.LoadOrder, mod.ModFolder);

        var notice = Assert.IsType<ExternalChangeNotification>(Assert.Single(_notifications.Notifications));
        Assert.Equal([new ChangedPlugin(mod.Plugin.Name, Sha256(before))], notice.Plugins);
    }

    private static Dictionary<string, string> FilesUnder(string folder) =>
        Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
            .ToDictionary(path => Path.GetRelativePath(folder, path), path => Sha256(File.ReadAllBytes(path)));
}
