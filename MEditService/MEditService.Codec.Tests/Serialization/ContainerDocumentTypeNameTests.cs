using System.Text;
using MEditService.Codec.Serialization;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Serialization;

/// <summary>The name a refusal prints for a document comes from here, and a refusal naming nothing
/// documents nothing.</summary>
public sealed class ContainerDocumentTypeNameTests
{
    private static readonly ContainerDocuments Documents = new(
        GameRelease.Fallout4, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4));

    private static string TypeNameOf(string pathRecordType, string body) =>
        Documents.TypeNameOf(pathRecordType, Encoding.UTF8.GetBytes(body));

    [Fact]
    public void APathNamingASchemaTable_IsThatTable()
    {
        Assert.Equal("npc_", TypeNameOf("npc_", """{"FormKey": "000801:Test.esp"}"""));
    }

    [Fact]
    public void APathNamingNoTable_IsTheTableTheDocumentsOwnTypeBelongsTo()
    {
        Assert.Equal(
            "glob",
            TypeNameOf("GlobalFloat", """{"MutagenObjectType": "GlobalFloat", "FormKey": "000801:Test.esp"}"""));
    }

    [Theory]
    [InlineData("NotARecordClass", """{"MutagenObjectType": "NotARecordClass"}""", "NotARecordClass")]
    [InlineData("NotARecordClass", """{"FormKey": "000801:Test.esp"}""", "NotARecordClass")]
    [InlineData("NotARecordClass", "not json at all", "NotARecordClass")]
    public void ADocumentNoSchemaIndexes_IsStillNamed(string pathRecordType, string body, string expected)
    {
        Assert.Equal(expected, TypeNameOf(pathRecordType, body));
    }
}
