using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Starfield;

namespace MEditService.Codec.Tests.Schema;

public sealed class StarfieldConditionSchemaTests
{
    private static FieldMetadata Data() =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield)["qust"].RecordColumns.Single(c => c.Name == "DialogConditions")
            .Field.ElementType.Require().Fields.Require().Single(f => f.Name == "Data");

    [Fact]
    public void GetEventDatasOwnFunction_IsItsEventFunction_NotMutagensUnheldFunction()
    {
        var function = Data().Fields.Require().Single(f => f.Name == "Function").Variants.Require();

        Assert.Equal(
            Enum.GetNames<GetEventDataConditionData.EventFunction>(),
            function[nameof(GetEventDataConditionData)].EnumMembers.Select(m => m.Value));
    }
}
