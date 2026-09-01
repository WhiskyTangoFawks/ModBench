using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Exceptions;
using Mutagen.Bethesda.Plugins.Masters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Exceptions;

namespace MEditService.Tests.Source;

/// <summary>
/// Unit-level pins for <see cref="PluginDiagnosis"/>'s own three factories, complementing the real,
/// end-to-end fixtures in <c>RealData/PluginDiagnosisRoundTripGateTests.cs</c>,
/// <c>RealData/MasterPruningRoundTripGateTests.cs</c> and
/// <c>Edits/PluginCompileServiceDiagnosisTests.cs</c>/<c>Edits/PluginCompileServiceMasterPruningTests.cs</c>.
/// This file's own job is the shapes those real fixtures can't reach cheaply — chiefly the
/// nested-<see cref="AggregateException"/> chain-walk — built from real defects' own
/// captured messages (<c>SouthOfTheSea.esm</c> REFR <c>431EDC</c>; <c>SpaDia_AMR.esp</c> Quest
/// <c>DiaQ_LLInjector_SpadeyAMR</c>; both found live) rather than committing every fixture this
/// repo needs a shape from.
/// </summary>
public sealed class PluginDiagnosisTests
{
    /// <summary>
    /// Proven at the unit level: Mutagen enriches identity onto the exception nearest
    /// where a record was actually being parsed and rethrows outward through however many
    /// <see cref="AggregateException"/>s its own parallel record-block parsing used — live against
    /// <c>SouthOfTheSea.esm</c>'s real REFR <c>XWPG</c>/<c>XWPN</c> defect, the exception
    /// <c>Fallout4Mod.CreateFromBinary</c> actually threw was a bare <see cref="RecordException"/>
    /// with no identity at all (only <c>EnrichAndThrow(ex, modKey)</c> ran), three levels above the
    /// <see cref="SubrecordException"/> that carried the real identity — reproduced verbatim here.
    /// A caller that reads only the caught exception's own properties would anchor on nothing.
    /// </summary>
    [Fact]
    public void FromParseException_WalksNestedAggregateExceptionsForTheInnermostRecordException()
    {
        var formKey = FormKey.Factory("431EDC:SouthOfTheSea.esm");
        var modKey = Mutagen.Bethesda.Plugins.ModKey.FromFileName("SouthOfTheSea.esm");

        var innermost = new SubrecordException(
            new RecordType("XWPN"), formKey, typeof(PlacedObject), modKey, "00sots_Necropolis_WorkshopRef",
            "Expected header was not read in: XWPN");
        var aggregate1 = new AggregateException("One or more errors occurred. (Expected header was not read in: XWPN)", innermost);
        var aggregate2 = new AggregateException("One or more errors occurred. (One or more errors occurred. (Expected header was not read in: XWPN))", aggregate1);
        var outer = new RecordException(formKey: null, recordType: null, modKey: modKey, edid: null, innerException: aggregate2);

        var diagnosis = PluginDiagnosis.FromParseException(outer);

        Assert.NotNull(diagnosis.Anchor);
        Assert.Contains("PlacedObject", diagnosis.Anchor);
        Assert.Contains("431EDC:SouthOfTheSea.esm", diagnosis.Anchor);
        Assert.Contains("00sots_Necropolis_WorkshopRef", diagnosis.Anchor);
        Assert.Equal("Expected header was not read in: XWPN", diagnosis.Message);
        Assert.Equal(PluginDiagnosis.UnknownClass, diagnosis.DefectClass);
        Assert.Null(diagnosis.Tail);
    }

    /// <summary>
    /// The multi-exception half: Mutagen's own parallel record-block parsing
    /// (<c>ListBinaryTranslation.ParseParallel</c>, a real <c>Parallel.ForEach</c>) can produce an
    /// <see cref="AggregateException"/> holding more than one failure when concurrent iterations fail
    /// simultaneously — realistic for any plugin with more than one corrupt record.
    /// <see cref="Exception.InnerException"/> on a multi-exception <see cref="AggregateException"/>
    /// only ever forwards to <see cref="AggregateException.InnerExceptions"/>'s first element, so a
    /// walk that follows only <c>.InnerException</c> would see the unrelated first branch, never visit
    /// the second branch at all, and silently anchor on nothing — exactly the failure mode this test
    /// exists to catch. The identity-bearing exception is deliberately placed second, not first.
    /// </summary>
    [Fact]
    public void FromParseException_WalksEveryBranchOfAMultiExceptionAggregateNotJustTheFirst()
    {
        var formKey = FormKey.Factory("431EDC:SouthOfTheSea.esm");
        var modKey = Mutagen.Bethesda.Plugins.ModKey.FromFileName("SouthOfTheSea.esm");
        var unrelatedFirstBranch = new InvalidOperationException("unrelated failure in a different parallel iteration");
        var identityBearingSecondBranch = new SubrecordException(
            new RecordType("XWPN"), formKey, typeof(PlacedObject), modKey, "SecondBranchRef",
            "Expected header was not read in: XWPN");
        var aggregate = new AggregateException("One or more errors occurred.", unrelatedFirstBranch, identityBearingSecondBranch);
        var outer = new RecordException(formKey: null, recordType: null, modKey: modKey, edid: null, innerException: aggregate);

        var diagnosis = PluginDiagnosis.FromParseException(outer);

        Assert.NotNull(diagnosis.Anchor);
        Assert.Contains("PlacedObject", diagnosis.Anchor);
        Assert.Contains("431EDC:SouthOfTheSea.esm", diagnosis.Anchor);
        Assert.Contains("SecondBranchRef", diagnosis.Anchor);
    }

    /// <summary>Nothing in the chain is a <see cref="RecordException"/>
    /// at all, so the diagnosis anchors on nothing — never a guessed identity.</summary>
    [Fact]
    public void FromParseException_WhenNoRecordExceptionIsAnywhereInTheChain_AnchorsOnNothing()
    {
        var diagnosis = PluginDiagnosis.FromParseException(new InvalidOperationException("boom"));

        Assert.Null(diagnosis.Anchor);
        Assert.Equal("boom", diagnosis.Message);
        Assert.Equal(PluginDiagnosis.UnknownClass, diagnosis.DefectClass);
    }

    /// <summary>The one Kind A entry with a real, reproducible fixture — <c>Clipboards to the
    /// BOS.esp</c>'s exact message, reproduced verbatim (not paraphrased) since the table matches on
    /// substring.</summary>
    [Fact]
    public void FromParseException_RecognizesTheRealClipboardsMessageAsKindA()
    {
        var ex = new RecordException(
            formKey: null, recordType: null, modKey: Mutagen.Bethesda.Plugins.ModKey.FromFileName("Clipboards to the BOS.esp"),
            edid: null, message: "All FNAM strings should be the same");

        var diagnosis = PluginDiagnosis.FromParseException(ex);

        Assert.Equal("blocked upstream: Mutagen #687", diagnosis.Tail);
    }

    /// <summary>Compile's own seam: a <see cref="FilePathedException"/> anchors on the source file
    /// itself, made relative to the tree root — the same identity unit
    /// <c>PluginCompileService.RefuseIfSourceDoesNotRoundTrip</c> already names.</summary>
    [Fact]
    public void FromSourceReadException_AnchorsOnTheFilePathRelativeToTheTree()
    {
        var treeRoot = Path.Combine(Path.GetTempPath(), "medit-diagnosis-unit-tree");
        var filePath = Path.Combine(treeRoot, "Npcs", "[0] FixtureNpc - 000802_Fixture.esp.json");
        var ex = FilePathedException.Enrich(new ArgumentException("Malformed FormKey string: NOT-A-FORMKEY"), filePath);

        var diagnosis = PluginDiagnosis.FromSourceReadException(ex, treeRoot);

        Assert.Equal(Path.Combine("Npcs", "[0] FixtureNpc - 000802_Fixture.esp.json"), diagnosis.Anchor);
        Assert.Equal("Malformed FormKey string: NOT-A-FORMKEY", diagnosis.Message);
        Assert.Equal(PluginDiagnosis.UnknownClass, diagnosis.DefectClass);
    }

    [Fact]
    public void Describe_WithNoAnchorAndNoTail_NamesThePluginAndTheUnknownClass()
    {
        var diagnosis = new PluginDiagnosis(Anchor: null, DefectClass: PluginDiagnosis.UnknownClass, Tail: null, Message: "boom");

        Assert.Equal("the plugin — unknown: boom", diagnosis.Describe());
    }

    [Fact]
    public void Describe_AClassedDiagnosisWithATail_CarriesBoth()
    {
        // A Kind B diagnosis (#569) knows its class *and* its repair tail; neither may shadow
        // the other in the refusal text. Kind A stays as before: its class is `unknown`, so
        // only the tail shows.
        var diagnosis = new PluginDiagnosis(
            Anchor: "REGN 001D2AF4 (DowntownRegion)", DefectClass: "fixed-size-subrecord-short",
            Tail: "repairable (lossless)", Message: "RDAT is 6 bytes; a REGN RDAT is always 8");

        Assert.Equal(
            "REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8",
            diagnosis.Describe());
    }

    /// <summary>The write seam: the exact nested shape observed live against
    /// <c>SpaDia_AMR.esp</c> (<c>AggregateException(AggregateException(RecordException(UnmappableFormIDException)))</c>,
    /// from Mutagen's own <c>WriteGroupParallel</c>/<c>WriteQuestsParallel</c>) — the anchor comes from
    /// the <see cref="RecordException"/> exactly as <see cref="FromParseException"/>'s own walk finds
    /// it, and the master name comes from the deeper, differently-typed
    /// <see cref="UnmappableFormIDException"/> nobody else's factory looks for.</summary>
    [Fact]
    public void FromWriteException_NamesTheRecordAndThePrunedMasterFromTwoDifferentExceptionTypes()
    {
        var questFormKey = FormKey.Factory("0000DD:SpaDia_AMR.esp");
        var nukaWorldFormKey = FormKey.Factory("03F98D:DLCNukaWorld.esm");
        var modKey = ModKey.FromFileName("SpaDia_AMR.esp");

        var unmappable = new UnmappableFormIDException(
            new FormLinkInformation(nukaWorldFormKey, typeof(IFallout4MajorRecordGetter)), new StubMasterPackage());
        var recordEx = new RecordException(
            formKey: questFormKey, recordType: typeof(Quest), modKey: modKey, edid: "DiaQ_LLInjector_SpadeyAMR",
            innerException: unmappable);
        var aggregate1 = new AggregateException("One or more errors occurred. (Could not map FormKey to a master index)", recordEx);
        var aggregate2 = new AggregateException("One or more errors occurred. (One or more errors occurred. (Could not map FormKey to a master index))", aggregate1);

        var diagnosis = PluginDiagnosis.FromWriteException(aggregate2);

        Assert.NotNull(diagnosis.Anchor);
        Assert.Contains("Quest", diagnosis.Anchor);
        Assert.Contains("0000DD:SpaDia_AMR.esp", diagnosis.Anchor);
        Assert.Contains("DiaQ_LLInjector_SpadeyAMR", diagnosis.Anchor);
        Assert.Contains("DLCNukaWorld.esm", diagnosis.Message);
        Assert.Equal("likely blocked upstream: Mutagen #688 (FormLinks inside a VMAD struct-list " +
            "script property are the known cause of this shape, not confirmed for every instance)", diagnosis.Tail);
        Assert.Contains("DiaQ_LLInjector_SpadeyAMR", diagnosis.Describe());
        Assert.Contains("DLCNukaWorld.esm", diagnosis.Describe());
        Assert.Contains("Mutagen #688", diagnosis.Describe());
    }

    /// <summary>The catch-filter test both write call sites (<c>TrackService.VerifyRoundTrip</c>,
    /// <c>PluginCompileService.Compile</c>) share: an exception tree that never carries
    /// <see cref="UnmappableFormIDException"/> must not be diverted into this Kind A row — every other
    /// write failure keeps propagating unchanged (a deliberate decision, out of scope to widen).</summary>
    [Fact]
    public void HasUnmappableFormID_WhenNoUnmappableFormIDExceptionIsAnywhereInTheChain_IsFalse()
    {
        Assert.False(PluginDiagnosis.HasUnmappableFormID(new InvalidOperationException("boom")));
    }

    [Fact]
    public void HasUnmappableFormID_WhenNestedInsideAggregatesAndARecordException_IsTrue()
    {
        var unmappable = new UnmappableFormIDException(
            new FormLinkInformation(FormKey.Factory("03F98D:DLCNukaWorld.esm"), typeof(IFallout4MajorRecordGetter)),
            new StubMasterPackage());
        var recordEx = new RecordException(formKey: null, recordType: null, modKey: null, edid: null, innerException: unmappable);
        var aggregate = new AggregateException(recordEx);

        Assert.True(PluginDiagnosis.HasUnmappableFormID(aggregate));
    }

    /// <summary>A minimal stub — <see cref="UnmappableFormIDException"/>'s constructor requires an
    /// <see cref="IReadOnlySeparatedMasterPackage"/>, but nothing under test here ever reads it (only
    /// <see cref="UnmappableFormIDException.UnmappableFormKey"/> is), so every member throws.</summary>
    private sealed class StubMasterPackage : IReadOnlySeparatedMasterPackage
    {
        public ModKey CurrentMod => throw new NotSupportedException();
        public IReadOnlyMasterReferenceCollection Raw => throw new NotSupportedException();
        public bool TryLookupModKey(ModKey modKey, bool reference, out MasterStyle style, out uint index) =>
            throw new NotSupportedException();
        public FormKey GetFormKey(FormID formId, bool reference) => throw new NotSupportedException();
        public FormID GetFormID(FormKey formKey) => throw new NotSupportedException();
    }
}
