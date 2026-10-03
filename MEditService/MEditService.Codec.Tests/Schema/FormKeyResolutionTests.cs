using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class FormKeyResolutionTests
{
    [Fact]
    public void From_NullEntry_ReturnsUnresolved()
    {
        var resolution = FormKeyResolution.From("000001:Test.esp", null, ["race"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.Unresolved, resolution.State);
        Assert.Null(resolution.RecordType);
        Assert.Null(resolution.EditorId);
    }

    [Fact]
    public void From_EntryOfWrongType_ReturnsResolvedWrongType()
    {
        var entry = new ResolvedFormKey("npc_", "SomeNpc");
        var resolution = FormKeyResolution.From("001234:Test.esp", entry, ["race"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.ResolvedWrongType, resolution.State);
        Assert.Equal("npc_", resolution.RecordType);
        Assert.Equal("SomeNpc", resolution.EditorId);
    }

    [Fact]
    public void From_EntryOfValidType_ReturnsResolvedValidType()
    {
        var entry = new ResolvedFormKey("race", "SomeRace");
        var resolution = FormKeyResolution.From("001234:Test.esp", entry, ["race"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolution.State);
        Assert.Equal("race", resolution.RecordType);
        Assert.Equal("SomeRace", resolution.EditorId);
    }

    [Fact]
    public void From_NoValidTypesConstraint_AnyResolvedTypeIsValid()
    {
        var entry = new ResolvedFormKey("npc_", "AnyRecord");
        var resolution = FormKeyResolution.From("001234:Test.esp", entry, [], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolution.State);
    }

    [Fact]
    public void From_EngineHardcodedFormKeyMissingFromLookup_ResolvesValidTypeBypassingValidation_BecauseAMissInTheImplicitlyAlwaysLoadedMastersModuleSpaceIsARecordTypeTheLookupNeverCarried()
    {
        var resolution = FormKeyResolution.From("000007:Fallout4.esm", null, ["npc_"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolution.State);
        Assert.Null(resolution.RecordType);
        Assert.Null(resolution.EditorId);
    }

    [Fact]
    public void From_LowObjectIdInOrdinaryPlugin_StaysUnresolved_BecauseItIsABrokenReferenceNotAnEngineConstantSoGatingOnObjectIdAloneIsWrong()
    {
        var resolution = FormKeyResolution.From("000007:SomeMod.esp", null, ["npc_"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.Unresolved, resolution.State);
    }

    [Fact]
    public void From_ObjectId0x800AtHighRangeBoundary_StaysUnresolved_BecauseItIsTheFirstOrdinaryNonReservedObjectIdAndMustStillBeChecked()
    {
        var resolution = FormKeyResolution.From("000800:Fallout4.esm", null, ["npc_"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.Unresolved, resolution.State);
    }

    [Fact]
    public void From_ObjectIdJustBelowHighRangeBoundary_ResolvesValidType_BecauseOneBelow0x800IsStillReserved()
    {
        var resolution = FormKeyResolution.From("0007FF:Fallout4.esm", null, ["npc_"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolution.State);
    }

    [Fact]
    public void From_MalformedFormKeyString_StaysUnresolved_DoesNotThrow_BecauseItReachesHereBeforeTheEditRefusalAndFormKeyFactoryThrowsSoUnparseableMeansNotHardcoded()
    {
        var resolution = FormKeyResolution.From("not-a-formkey", null, ["npc_"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.Unresolved, resolution.State);
    }
}
