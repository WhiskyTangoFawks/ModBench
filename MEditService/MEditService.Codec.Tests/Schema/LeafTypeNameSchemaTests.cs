using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Schema;

public class LeafTypeNameSchemaTests
{
    [Theory]
    [InlineData("npc_", "Destructible", nameof(Destructible))]
    [InlineData("acti", "Conditions.[].Data", nameof(ConditionData))]
    [InlineData("npc_", "VirtualMachineAdapter.Scripts.[]", nameof(ScriptEntry))]
    [InlineData("npc_", "VirtualMachineAdapter.Scripts.[].Properties.[].Objects.[]", nameof(ScriptObjectProperty))]
    public void AStructOrANonUnionArrayElement_NamesItsLoquiClass(string table, string path, string loquiClass) =>
        Assert.Equal(loquiClass, SchemaFields.At(GameRelease.Fallout4, table, path).LeafTypeName);

    [Fact]
    public void UnionArrayElement_NamesItsBaseClass_AndKeepsItsDiscriminator_BecauseTheSchemaDeclaredClassAndTheValuesClassAreDifferentFacts()
    {
        var element = SchemaFields.At(GameRelease.Fallout4, "acti", "Conditions.[]");

        Assert.Equal(nameof(Condition), element.LeafTypeName);
        var fields = element.Fields
            ?? throw new InvalidOperationException("Expected the union element to declare fields.");
        Assert.Contains(fields, f => f.IsDiscriminator);
    }

    [Fact]
    public void EveryStructInTheSchema_NamesItsType_BecauseNamingAFewByHandProvesNothingAboutAnElementTheWalkBuildsWithoutAName() =>
        Assert.Empty(PathsWhere(m => m.Type == "struct" && string.IsNullOrEmpty(m.LeafTypeName)));

    [Fact]
    public void NothingButAStruct_NamesAType_SoLeafTypeNameStaysTheAnswerToOneQuestionNotASecondCopyOfType() =>
        Assert.Empty(PathsWhere(m => m.Type != "struct" && m.LeafTypeName != null));

    [Fact]
    public void NoStructIsNamedByItsGetterInterface_BecauseALeafNameIsDrawnFromTheSameVocabularyAsAUnionsDiscriminatorValuesOrTheTwoKeyThePresentationTableDifferently() =>
        Assert.Empty(PathsWhere(m => m.LeafTypeName?.EndsWith("Getter", StringComparison.Ordinal) == true));

    private static List<string> PathsWhere(Func<FieldMetadata, bool> predicate) =>
        [.. SchemaFields.All(GameRelease.Fallout4).Where(f => predicate(f.Field)).Select(f => f.Path)];
}
