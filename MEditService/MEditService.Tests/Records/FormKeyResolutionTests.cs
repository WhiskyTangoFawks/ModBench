using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

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
        var entry = new RecordLookupEntry("npc_", "SomeNpc");
        var resolution = FormKeyResolution.From("001234:Test.esp", entry, ["race"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.ResolvedWrongType, resolution.State);
        Assert.Equal("npc_", resolution.RecordType);
        Assert.Equal("SomeNpc", resolution.EditorId);
    }

    [Fact]
    public void From_EntryOfValidType_ReturnsResolvedValidType()
    {
        var entry = new RecordLookupEntry("race", "SomeRace");
        var resolution = FormKeyResolution.From("001234:Test.esp", entry, ["race"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolution.State);
        Assert.Equal("race", resolution.RecordType);
        Assert.Equal("SomeRace", resolution.EditorId);
    }

    [Fact]
    public void From_NoValidTypesConstraint_AnyResolvedTypeIsValid()
    {
        var entry = new RecordLookupEntry("npc_", "AnyRecord");
        var resolution = FormKeyResolution.From("001234:Test.esp", entry, [], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolution.State);
    }

    // Engine-hardcoded FormIDs (Player 00000007 and friends) — a lookup miss in the
    // implicitly-always-loaded master's module space is not a broken link, it is a record type the
    // lookup was never going to carry. xEdit's own reference (wbImplementation.pas,
    // FileFormIDtoLoadOrderFormID/RemoveMainRecord): ObjectID < $800 gates the same way.
    [Fact]
    public void From_HardcodedFormKeyMissingFromLookup_ResolvesValidTypeBypassingValidation()
    {
        var resolution = FormKeyResolution.From("000007:Fallout4.esm", null, ["npc_"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolution.State);
        Assert.Null(resolution.RecordType);
        Assert.Null(resolution.EditorId);
    }

    // Module-space guard (rival: gate on ObjectID alone) — a low ObjectID in a plugin that is not
    // implicitly-always-loaded is an ordinary broken reference, not an engine constant.
    [Fact]
    public void From_LowObjectIdInOrdinaryPlugin_StaysUnresolved()
    {
        var resolution = FormKeyResolution.From("000007:SomeMod.esp", null, ["npc_"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.Unresolved, resolution.State);
    }

    // Boundary guard (rival: off-by-one, <= instead of <) — $800 itself is the first ordinary,
    // non-reserved ObjectID and must still be checked normally.
    [Fact]
    public void From_ObjectIdAtHighRangeBoundary_StaysUnresolved()
    {
        var resolution = FormKeyResolution.From("000800:Fallout4.esm", null, ["npc_"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.Unresolved, resolution.State);
    }

    // The other side of the same boundary — one ObjectID below it is still reserved.
    [Fact]
    public void From_ObjectIdJustBelowHighRangeBoundary_ResolvesValidType()
    {
        var resolution = FormKeyResolution.From("0007FF:Fallout4.esm", null, ["npc_"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolution.State);
    }

    // A malformed, not-yet-validated editor
    // string (e.g. "not-a-formkey") reaches here too, before RecordEditService's own refusal path
    // has a chance to reject it — FormKey.Factory throws for it, so the hardcoded check must use
    // TryFactory and treat "can't even parse" as "definitely not hardcoded", same as any other miss.
    [Fact]
    public void From_MalformedFormKeyString_StaysUnresolved_DoesNotThrow()
    {
        var resolution = FormKeyResolution.From("not-a-formkey", null, ["npc_"], GameRelease.Fallout4);
        Assert.Equal(FormKeyResolutionState.Unresolved, resolution.State);
    }
}
