using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginLocalizedTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly ScratchDirectory _modFolder = new("medit-compile-localized-");
    private readonly ScratchDirectory _gameDir = new("medit-compile-localized-game-");
    private readonly LoadOrderSnapshot _loadOrder;

    public CompilePluginLocalizedTests()
    {
        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var door = mod.Doors.AddNew("MainDoor");
        door.Name = new TranslatedString(Language.English, "The Big Door");
        mod.UsingLocalization = true;
        mod.WriteToBinary(pluginPath);

        _loadOrder = SnapshotPlugins.Snapshot(
            _gameDir, instanceRoot: null, GameRelease.Fallout4,
            [new LoadOrderEntry(PluginName, pluginPath, Origin, Line: 0, Enabled: true, Winning: true)]);

        TrackEveryPluginOf.ModAsync(_loadOrder, Origin)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _modFolder.Dispose();
        _gameDir.Dispose();
    }

    private static void RemoveStringsMutagenLeftAtTheTempWritePathSoTheByteCompareCannotPassVacuously(
        string stringsDir, IEnumerable<string> fileNames)
    {
        foreach (var fileName in fileNames)
            File.Delete(Path.Combine(stringsDir, fileName));
    }

    [Fact]
    public async Task Compile_ALocalizedPlugin_WritesStringsBesideItByteIdenticalToTheInput()
    {
        var pluginPath = Path.Combine(_modFolder, PluginName);
        var stringsDir = Path.Combine(_modFolder, "Strings");
        var originalStringsFiles = Directory.GetFiles(stringsDir)
            .ToDictionary(f => Path.GetFileName(f) ?? throw new InvalidOperationException("Expected a file path to have a file name."), File.ReadAllBytes);
        Assert.NotEmpty(originalStringsFiles);

        RemoveStringsMutagenLeftAtTheTempWritePathSoTheByteCompareCannotPassVacuously(stringsDir, originalStringsFiles.Keys);

        var plugin = new PluginAddress(PluginName, Origin);
        var compileService = CompileServices.Over(_loadOrder);
        var answer = await compileService.CompileAsync([plugin]);

        Assert.Empty(answer.Refused);
        Assert.Single(answer.Landed);

        using (var recompiled = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), Fallout4Release.Fallout4))
        {
            Assert.True(recompiled.ModHeader.Flags.HasFlag(Fallout4ModHeader.HeaderFlag.Localized));
        }

        foreach (var (fileName, originalBytes) in originalStringsFiles)
        {
            var recompiledPath = Path.Combine(stringsDir, fileName);
            Assert.True(File.Exists(recompiledPath), $"expected {recompiledPath}");
            Assert.True(originalBytes.AsSpan().SequenceEqual(File.ReadAllBytes(recompiledPath)),
                $"{fileName} differs after compile.");
        }
    }
}
