using System.Buffers.Binary;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.RealData;

public sealed class StaleNextObjectIdRoundTripGateTests
{
    private const int HeaderLength = 24;
    private const int InflatedLengthSize = 4;

    public static TheoryData<string, uint> GeneratedPluginsWithAStaleHeader => new()
    {
        { StaleHeaderPlugins.SettingsFileName, 5 },
        { StaleHeaderPlugins.SierraFileName, 4 },
        { StaleHeaderPlugins.HitechFileName, 11 },
    };

    public static TheoryData<string> TrackAndCompileGeneratedPlugins => new()
    {
        StaleHeaderPlugins.SettingsFileName,
        StaleHeaderPlugins.SierraFileName,
        StaleHeaderPlugins.HitechFileName,
    };

    [Theory]
    [MemberData(nameof(GeneratedPluginsWithAStaleHeader))]
    public async Task Save_OfAGeneratedPluginWithAStaleHeader_KeepsItsNextObjectId_AndDerivesNumRecordsFromContent(
        string fileName, uint derivedNumRecords)
    {
        using var scratch = new TrackedScratch(fileName);
        var stale = StaleHeaderPlugins.Named(fileName);
        Assert.Equal((stale.StoredNextObjectId, stale.StoredNumRecords), ReadHeaderStats(scratch.PluginPath));

        using (var prep = await TreeSaves.PrepareAsync(scratch.PluginPath))
        {
            prep.Commit();
        }

        Assert.Equal((stale.StoredNextObjectId, derivedNumRecords), ReadHeaderStats(scratch.PluginPath));
    }

    [Theory]
    [MemberData(nameof(TrackAndCompileGeneratedPlugins))]
    public async Task Track_OfAGeneratedPluginWithAStaleHeader_Succeeds(string fileName)
    {
        using var scratch = new TrackedScratch(fileName);

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Theory]
    [MemberData(nameof(TrackAndCompileGeneratedPlugins))]
    public async Task Compile_OfAGeneratedPluginWithAStaleHeader_ReproducesTheSourceContent(string fileName)
    {
        using var scratch = new TrackedScratch(fileName);
        var original = Fallout4Mod.CreateFromBinary(
            new ModPath(ModKey.FromFileName(fileName), scratch.PluginPath), Fallout4Release.Fallout4);
        await scratch.TrackAsync();

        await scratch.CompileService().CompileLandedAsync(scratch.Plugin);

        var compiled = Fallout4Mod.CreateFromBinary(
            new ModPath(ModKey.FromFileName(fileName), scratch.PluginPath), Fallout4Release.Fallout4);
        var divergence = ModelIdentity.FindFirstDivergence(original, compiled);
        Assert.Null(divergence);
    }

    [Theory]
    [InlineData(StaleHeaderPlugins.SierraFileName)]
    [InlineData(StaleHeaderPlugins.HitechFileName)]
    public async Task Compile_OfAGeneratedPluginDeflatedAtAnotherLevel_RewritesItsCompressedRecordsAtMutagensLevel(string fileName)
    {
        using var scratch = new TrackedScratch(fileName);
        var originalHeader = ZlibHeaderOfFirstMisc(await File.ReadAllBytesAsync(scratch.PluginPath));
        await scratch.TrackAsync();

        await scratch.CompileService().CompileLandedAsync(scratch.Plugin);

        Assert.NotEqual(originalHeader, ZlibHeaderOfFirstMisc(await File.ReadAllBytesAsync(scratch.PluginPath)));
    }

    [Fact]
    public async Task Track_WithAnExtraRecordInTheRecompiledPlugin_NamesThatRecord()
    {
        using var scratch = new TrackedScratch(StaleHeaderPlugins.SettingsFileName);
        FormKey? extra = null;

        async Task<IMod> DeserializeThenAddAnNpc(string folder, CancellationToken ct)
        {
            var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
            extra = deserialized.Npcs.AddNew("ExtraNpc").FormKey;
            return deserialized;
        }

        var result = await scratch.TrackAsync(DeserializeThenAddAnNpc);

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        var extraFormKey = extra
            ?? throw new InvalidOperationException("Expected DeserializeThenAddAnNpc to run and set extra.");
        Assert.Contains(extraFormKey.ToString(), result.Message);
        Assert.Contains("ExtraNpc", result.Message);
        Assert.Contains("not present in the original", result.Message);
    }

    private static int MiscGroupOffset(byte[] plugin)
    {
        var tes4Size = BinaryPrimitives.ReadUInt32LittleEndian(plugin.AsSpan(4));
        var group = HeaderLength + (int)tes4Size;
        Assert.Equal("GRUP"u8.ToArray(), plugin[group..(group + 4)]);
        Assert.Equal("MISC"u8.ToArray(), plugin[(group + 8)..(group + 12)]);
        return group;
    }

    private static ushort ZlibHeaderOfFirstMisc(byte[] plugin)
    {
        var group = MiscGroupOffset(plugin);
        return BinaryPrimitives.ReadUInt16BigEndian(plugin.AsSpan(group + HeaderLength + HeaderLength + InflatedLengthSize));
    }

    private static (uint NextObjectId, uint NumRecords) ReadHeaderStats(string pluginPath)
    {
        using var overlay = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(Path.GetFileName(pluginPath)), pluginPath), Fallout4Release.Fallout4);
        return (overlay.ModHeader.Stats.NextFormID, overlay.ModHeader.Stats.NumRecords);
    }

    private sealed class TrackedScratch : IDisposable
    {
        internal LoadOrderHolder Holder { get; } = new();
        private readonly ScratchDirectory _gameDirectory = new("medit-stale-header-game-");
        private readonly LoadOrderSnapshot _loadOrder;

        public ScratchDirectory ModFolder { get; } = new("medit-stale-header-");
        public string PluginPath { get; }
        public PluginAddress Plugin { get; }

        public TrackedScratch(string fileName)
        {
            PluginPath = Path.Combine(ModFolder, fileName);
            StaleHeaderPlugins.Named(fileName).WriteInto(ModFolder);
            Plugin = new PluginAddress(fileName, "FixtureMod");

            _loadOrder = EmptyMasterStubs.LoadOrderOver(PluginPath, Plugin.Origin, _gameDirectory);
            Holder.Apply(_loadOrder);
        }

        public async Task<PluginTrack> TrackAsync(Func<string, CancellationToken, Task<IMod>>? deserialize = null) =>
            (await TrackEveryPluginOf.ModAsync(
                _loadOrder, Plugin.Origin,
                deserialize is { } forged ? new ForgedTreeWriteAdapter(Plugin.Name, forged) : null)).Only();

        public CompilePluginHandler CompileService() =>
            CompileServices.Over(Holder.Current);

        public void Dispose()
        {
            ModFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
