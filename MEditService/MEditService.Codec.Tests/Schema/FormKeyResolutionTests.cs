using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class FormKeyResolutionTests
{
    private static ResolvedFormKey? Held(string? recordType) => recordType is null ? null : new ResolvedFormKey(recordType, "HeldRecord");

    [Theory]
    [InlineData("a key the lookup lacks", "000001:Test.esp", null, "race", FormKeyResolutionState.Unresolved, null)]
    [InlineData("a key resolving to another type", "001234:Test.esp", "npc_", "race", FormKeyResolutionState.ResolvedWrongType, "npc_")]
    [InlineData("a key resolving to its type", "001234:Test.esp", "race", "race", FormKeyResolutionState.ResolvedValidType, "race")]
    [InlineData("a key of a link that names no type", "001234:Test.esp", "npc_", "", FormKeyResolutionState.ResolvedValidType, "npc_")]
    [InlineData("an engine-hardcoded key the lookup never carried", "000007:Fallout4.esm", null, "npc_", FormKeyResolutionState.ResolvedValidType, null)]
    [InlineData("a low object ID in an ordinary plugin, a broken link", "000007:SomeMod.esp", null, "npc_", FormKeyResolutionState.Unresolved, null)]
    [InlineData("the first ordinary object ID in a master", "000800:Fallout4.esm", null, "npc_", FormKeyResolutionState.Unresolved, null)]
    [InlineData("the last reserved object ID in a master", "0007FF:Fallout4.esm", null, "npc_", FormKeyResolutionState.ResolvedValidType, null)]
    [InlineData("text that is no FormKey, refused later by the edit", "not-a-formkey", null, "npc_", FormKeyResolutionState.Unresolved, null)]
    public void AKey_ResolvesByWhatTheLookupHoldsAndWhetherTheEngineHardcodesIt(
        string _, string formKey, string? held, string validTypes, FormKeyResolutionState state, string? recordType)
    {
        var resolution = FormKeyResolution.From(formKey, Held(held), validTypes.Split(',', StringSplitOptions.RemoveEmptyEntries), GameRelease.Fallout4);

        Assert.Equal((state, recordType, Held(held)?.EditorId), (resolution.State, resolution.RecordType, resolution.EditorId));
    }
}
