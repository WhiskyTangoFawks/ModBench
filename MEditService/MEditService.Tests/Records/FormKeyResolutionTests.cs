using MEditService.Core.Records;

namespace MEditService.Tests.Records;

public class FormKeyResolutionTests
{
    [Fact]
    public void From_NullEntry_ReturnsUnresolved()
    {
        var resolution = FormKeyResolution.From(null, ["race"]);
        Assert.Equal(FormKeyResolutionState.Unresolved, resolution.State);
        Assert.Null(resolution.RecordType);
        Assert.Null(resolution.EditorId);
    }

    [Fact]
    public void From_EntryOfWrongType_ReturnsResolvedWrongType()
    {
        var entry = new RecordLookupEntry("npc_", "SomeNpc");
        var resolution = FormKeyResolution.From(entry, ["race"]);
        Assert.Equal(FormKeyResolutionState.ResolvedWrongType, resolution.State);
        Assert.Equal("npc_", resolution.RecordType);
        Assert.Equal("SomeNpc", resolution.EditorId);
    }

    [Fact]
    public void From_EntryOfValidType_ReturnsResolvedValidType()
    {
        var entry = new RecordLookupEntry("race", "SomeRace");
        var resolution = FormKeyResolution.From(entry, ["race"]);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolution.State);
        Assert.Equal("race", resolution.RecordType);
        Assert.Equal("SomeRace", resolution.EditorId);
    }

    [Fact]
    public void From_NoValidTypesConstraint_AnyResolvedTypeIsValid()
    {
        var entry = new RecordLookupEntry("npc_", "AnyRecord");
        var resolution = FormKeyResolution.From(entry, []);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolution.State);
    }
}
