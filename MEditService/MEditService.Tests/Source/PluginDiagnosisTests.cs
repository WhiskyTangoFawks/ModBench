using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Exceptions;
using Mutagen.Bethesda.Plugins.Masters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Exceptions;

namespace MEditService.Tests.Source;

/// <summary>The shapes the real fixtures cannot reach cheaply, chiefly the nested
/// <see cref="AggregateException"/> chain walk, built from real defects' captured messages rather
/// than committing every fixture this needs a shape from.</summary>
public sealed class PluginDiagnosisTests
{
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

    [Fact]
    public void FromParseException_WhenNoRecordExceptionIsAnywhereInTheChain_AnchorsOnNothing()
    {
        var diagnosis = PluginDiagnosis.FromParseException(new InvalidOperationException("boom"));

        Assert.Null(diagnosis.Anchor);
        Assert.Equal("boom", diagnosis.Message);
        Assert.Equal(PluginDiagnosis.UnknownClass, diagnosis.DefectClass);
    }

    [Fact]
    public void FromParseException_RecognizesTheRealClipboardsMessageAsKindA()
    {
        var ex = new RecordException(
            formKey: null, recordType: null, modKey: Mutagen.Bethesda.Plugins.ModKey.FromFileName("Clipboards to the BOS.esp"),
            edid: null, message: "All FNAM strings should be the same");

        var diagnosis = PluginDiagnosis.FromParseException(ex);

        Assert.Equal("blocked upstream: Mutagen #687", diagnosis.Tail);
    }

    [Fact]
    public void FromSourceReadException_AnchorsOnTheFilePathRelativeToTheTree()
    {
        var treeRoot = Path.Combine(Path.GetTempPath(), "medit-diagnosis-unit-tree");
        var filePath = Path.Combine(treeRoot, "Npcs", "FixtureNpc - 000802_Fixture.esp.json");
        var ex = FilePathedException.Enrich(new ArgumentException("Malformed FormKey string: NOT-A-FORMKEY"), filePath);

        var diagnosis = PluginDiagnosis.FromSourceReadException(ex, treeRoot);

        Assert.Equal(Path.Combine("Npcs", "FixtureNpc - 000802_Fixture.esp.json"), diagnosis.Anchor);
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
        // A Kind B diagnosis knows its class *and* its repair tail; neither may shadow
        // the other in the refusal text. Kind A stays as before: its class is `unknown`, so
        // only the tail shows.
        var diagnosis = new PluginDiagnosis(
            Anchor: "REGN 001D2AF4 (DowntownRegion)", DefectClass: "fixed-size-subrecord-short",
            Tail: "repairable (lossless)", Message: "RDAT is 6 bytes; a REGN RDAT is always 8");

        Assert.Equal(
            "REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8",
            diagnosis.Describe());
    }

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

    // Nothing under test reads the package, only UnmappableFormKey, so every member throws.
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
