using MEditService.Codec.Serialization;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Tests.RealData;

public sealed class PluginDiagnosisRoundTripGateTests
{
    [Fact]
    public async Task DecompileAndCommit_OfAMisshapedPerkPlugin_NamesThePerkRecordAsMalformedAndNoGesture()
    {
        using var scratch = new RealFixtureScratch(MisshapedPerkPlugin.Plugin);

        var result = await scratch.DecompileAndCommitAsync();

        Assert.False(result.Applied);
        Assert.Equal(DecompileAndCommitRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains(MisshapedPerkPlugin.Anchor, result.Message);
        Assert.Contains("malformed", result.Message);
        Assert.DoesNotContain("Decompile and repair", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False(TestAdapters.Source().IsSourceMod(scratch.ModFolder));
    }

    [Fact]
    public async Task DecompileAndCommit_OfAMismatchedFnamPlugin_NamesOnlyThePluginWhenMutagenReportsNoRecordIdentity()
    {
        using var scratch = new RealFixtureScratch(MismatchedFnamPlugin.Plugin);

        var result = await scratch.DecompileAndCommitAsync();

        Assert.False(result.Applied);
        Assert.Equal(DecompileAndCommitRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("All FNAM strings should be the same", result.Message);
        Assert.DoesNotContain("EditorID", result.Message);
        Assert.DoesNotContain("FormKey", result.Message);
    }

    [Fact]
    public async Task DecompileAndCommit_OfAMismatchedFnamPlugin_SaysMutagenMishandlesItAndNamesNoGesture()
    {
        using var scratch = new RealFixtureScratch(MismatchedFnamPlugin.Plugin);

        var result = await scratch.DecompileAndCommitAsync();

        Assert.False(result.Applied);
        Assert.Equal(DecompileAndCommitRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("blocked upstream: Mutagen #687", result.Message);
        Assert.Contains("Mutagen mishandles", result.Message);
        Assert.DoesNotContain("Decompile and repair", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("malformed", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain($"— {PluginDiagnosis.UnknownClass}:", result.Message);
    }

    public static TheoryData<MalformationFixture> Malformations => [.. MalformationFixtures.All];

    [Theory]
    [MemberData(nameof(Malformations))]
    public async Task DecompileAndCommit_OfAMalformedPlugin_NamesTheGestureOnlyWhenARepairAnswersIt(MalformationFixture fixture)
    {
        using var scratch = new RealFixtureScratch(fixture.Malformed);

        var result = await scratch.DecompileAndCommitAsync();

        Assert.Equal(DecompileAndCommitRefusal.RoundTripFailed, result.Refusal);
        Assert.Contains("malformed plugin", result.Message, StringComparison.Ordinal);
        Assert.Contains(fixture.Diagnosis, result.Message, StringComparison.Ordinal);
        Assert.Equal(fixture.Change is not null, result.Message.Contains("Decompile and repair", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task DecompileAndCommit_WhenMutagenFailsAtOneRecord_NamesThatRecordNotAnotherMalformedOne()
    {
        using var scratch = new RealFixtureScratch(MalformationFixtures.ShortRegionBesideAWrongCountRace);

        var result = await scratch.DecompileAndCommitAsync();

        Assert.Contains("HarborRace", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("HarborRegion", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecompileAndCommit_OfAPluginWithTrailingJunkTheMalformationScanCannotWalk_SaysSoAndDoesNotCallThePluginCorrect()
    {
        using var scratch = new RealFixtureScratch(MismatchedFnamPlugin.Plugin);
        File.AppendAllText(Path.Combine(scratch.ModFolder, MismatchedFnamPlugin.Plugin.FileName), "junk");

        var result = await scratch.DecompileAndCommitAsync();

        Assert.Contains("could not be checked for malformations", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("correct plugin", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(scratch.Log, entry => entry.Level == LogLevel.Warning && entry.Message.StartsWith("Could not check", StringComparison.Ordinal));
    }

    [Fact]
    public async Task DecompileAndCommit_WhenMutagenFailsAtNoRecordAndAnotherRecordIsMalformed_DoesNotCallThePluginCorrectOrNameTheGesture()
    {
        using var scratch = new RealFixtureScratch(MismatchedFnamPlugin.PluginWithAShortRegion);

        var result = await scratch.DecompileAndCommitAsync();

        Assert.Contains("Mutagen mishandles", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("correct plugin", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("HarborRegion", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Decompile and repair", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task DecompileAndCommit_WhenNothingClassifiesTheFailureAndAnotherRecordIsMalformed_NamesThatRecordAndNoGesture()
    {
        var plugin = new GeneratedPlugin("Unclassified.esp", RawPlugin.Plugin(RawPlugin.Tes4(0x802, 4),
            RawPlugin.Group("MISC", RawPlugin.Record("MISC", 0x00000800, RawPlugin.EditorId("HarborMisc"), RawPlugin.Subrecord("FULL", "x"u8.ToArray()), OverlongSubrecord)),
            RawPlugin.Group("REGN", RawPlugin.Record("REGN", 0x00000801, RawPlugin.EditorId("HarborRegion"), RawPlugin.Subrecord("RDAT", new byte[6])))));
        using var scratch = new RealFixtureScratch(plugin);

        var result = await scratch.DecompileAndCommitAsync();

        Assert.Contains("HarborRegion", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Decompile and repair", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("could not be parsed", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Mutagen mishandles", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("correct plugin", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static readonly byte[] OverlongSubrecord = [.. "DATA"u8.ToArray(), 100, 0, 1, 2];

    private sealed class RealFixtureScratch : IDisposable
    {
        private readonly ScratchDirectory _dataFolder = new("medit-diagnosis-data-");
        private readonly LoadOrderSnapshot _loadOrder;
        private const string Origin = "DiagnosisFixtureMod";

        public ScratchDirectory ModFolder { get; } = new("medit-diagnosis-mod-");

        public RealFixtureScratch(GeneratedPlugin plugin)
        {
            plugin.WriteInto(ModFolder);
            var pluginPath = Path.Combine(ModFolder, plugin.FileName);

            _loadOrder = EmptyMasterStubs.LoadOrderOver(pluginPath, Origin, _dataFolder);
        }

        public List<LogEntry> Log { get; } = [];

        public async Task<PluginDecompiledAndCommitted> DecompileAndCommitAsync()
        {
            var holder = new LoadOrderHolder();
            holder.Apply(_loadOrder);
            var handler = TestEditService.Over(holder, logging: logging => logging.AddProvider(new CollectingLoggerProvider(Log)))
                .GetRequiredService<DecompileAndCommitModHandler>();
            return (await handler.DecompileAndCommitAsync(ToDecompileAndCommit.In(_loadOrder, Origin))).Only();
        }

        public void Dispose()
        {
            ModFolder.Dispose();
            _dataFolder.Dispose();
        }
    }
}
