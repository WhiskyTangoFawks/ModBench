using System.Text.RegularExpressions;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Schema;

public sealed class DocumentWireSchemaTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static readonly Regex MutagenPascalCaseWithUnderscoreOnlyWhereMutagenWroteOneAsInEdgeLink_0_1 = new("^[A-Z][A-Za-z0-9_]*$", RegexOptions.Compiled);

    private static readonly string[] LeafKinds =
        ["bool", "int", "float", "string", "translatedString", "hex", "color", "vector", "enum", "flags", "formKey", "struct", "array"];

    private static FieldMetadata Column(string table, string name) =>
        Schemas[table].RecordColumns.Single(c => c.Name == name).Field;

    private static FieldMetadata Member(FieldMetadata owner, string name) => RequireFields(owner).Single(f => f.Name == name);

    private static IReadOnlyList<FieldMetadata> RequireFields(FieldMetadata meta) =>
        meta.Fields ?? throw new InvalidOperationException($"Expected '{meta.Name}' to have fields.");

    private static FieldMetadata RequireElementType(FieldMetadata meta) =>
        meta.ElementType ?? throw new InvalidOperationException($"Expected '{meta.Name}' to have an element type.");

    private static IReadOnlyDictionary<string, FieldMetadata> RequireVariants(FieldMetadata meta) =>
        meta.Variants ?? throw new InvalidOperationException($"Expected '{meta.Name}' to have variants.");

    [Fact]
    public void ALinkTypedByALinkInterface_NamesEveryTableWhoseGetterImplementsIt()
    {
        var types = Column("refr", "Base").ValidFormKeyTypes;

        Assert.Contains("stat", types);
        Assert.Contains("furn", types);
        Assert.DoesNotContain("race", types);
    }

    [Fact]
    public void NoLinkNamesEveryTable_BecauseNoTypesAlreadyMeansAny()
    {
        var tables = Schemas.Values.Count(s => !s.IsHeader);
        var offenders = SchemaFields.All(GameRelease.Fallout4).Where(f => f.Field.ValidFormKeyTypes.Count >= tables).Select(f => f.Path).ToList();

        Assert.Empty(offenders);
        Assert.Empty(SchemaFields.All(GameRelease.Fallout4).First(f => f.Path.EndsWith("Properties[].Object", StringComparison.Ordinal)).Field.ValidFormKeyTypes);
    }

    [Fact]
    public void EveryFieldName_IsAMutagenPropertyName()
    {
        var offenders = SchemaFields.All(GameRelease.Fallout4)
            .Where(f => f.Field.Name.Length > 0 && !MutagenPascalCaseWithUnderscoreOnlyWhereMutagenWroteOneAsInEdgeLink_0_1.IsMatch(f.Field.Name))
            .Select(f => f.Path)
            .ToList();

        Assert.Empty(offenders);
    }

    [Fact]
    public void EveryLeaf_IsNamedByAKindTheDocumentSpells()
    {
        var offenders = SchemaFields.All(GameRelease.Fallout4).Where(f => !LeafKinds.Contains(f.Field.Type)).Select(f => $"{f.Path}: {f.Field.Type}").ToList();

        Assert.Empty(offenders);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4, "npc_", "AggroRadiusBehaviorEnabled", "bool")]
    [InlineData(GameRelease.Fallout4, "imad", "Unknown", "int")]
    [InlineData(GameRelease.Fallout4, "header", "Author", "string")]
    [InlineData(GameRelease.Fallout4, "npc_", "Name", "translatedString")]
    [InlineData(GameRelease.Fallout4, "gras", "Unknown3", "hex")]
    [InlineData(GameRelease.Fallout4, "kywd", "Color", "color")]
    [InlineData(GameRelease.Fallout4, "refr", "Position", "vector")]
    [InlineData(GameRelease.Fallout4, "mato", "ProjectionVector", "vector")]
    [InlineData(GameRelease.Fallout4, "npc_", "Flags", "flags")]
    [InlineData(GameRelease.Fallout4, "npc_", "Aggression", "enum")]
    [InlineData(GameRelease.Fallout4, "npc_", "Weight", "struct")]
    [InlineData(GameRelease.SkyrimSE, "txst", "Diffuse", "string")]
    [InlineData(GameRelease.SkyrimSE, "sndr", "SoundFiles.[]", "string")]
    [InlineData(GameRelease.Starfield, "pndt", "OrbitedData.GravityWell", "float")]
    [InlineData(GameRelease.Starfield, "sech", "Markers.[].ECTE", "string")]
    public void ALeaf_IsNamedByTheKindTheCodecSpellsItAs(GameRelease release, string table, string path, string kind) =>
        Assert.Equal(kind, SchemaFields.At(release, table, path).Type);

    [Fact]
    public void EveryDiscriminator_IsTheDocumentsOwnObjectTypeMember_AnEnumOfDistinctLabelledLeavesTitledKind()
    {
        var discriminators = SchemaFields.All(GameRelease.Fallout4).Where(f => f.Field.IsDiscriminator || f.Field.Name == "MutagenObjectType").ToList();

        Assert.NotEmpty(discriminators);
        Assert.All(discriminators, d =>
        {
            Assert.True(d.Field.IsDiscriminator, d.Path);
            Assert.Equal("MutagenObjectType", d.Field.Name);
            Assert.Equal("enum", d.Field.Type);
            Assert.Equal("Kind", d.Field.DisplayLabel);
            Assert.NotEmpty(d.Field.EnumMembers);
            Assert.All(d.Field.EnumMembers, m => Assert.False(string.IsNullOrWhiteSpace(m.Label)));
            Assert.Equal(d.Field.EnumMembers.Count, d.Field.EnumMembers.Select(m => m.Label).Distinct(StringComparer.Ordinal).Count());
        });
    }

    [Fact]
    public void ConditionComparisonValue_IsOneMemberWithAVariantPerLeaf()
    {
        var conditionElement = RequireElementType(Column("cobj", "Conditions"));
        var comparison = Member(conditionElement, "ComparisonValue");
        var variants = RequireVariants(comparison);

        Assert.Equal("float", variants[nameof(ConditionFloat)].Type);
        Assert.Equal("formKey", variants[nameof(ConditionGlobal)].Type);
        Assert.DoesNotContain(RequireFields(conditionElement), f => f.Name.Contains('_'));
    }

    [Fact]
    public void ScriptPropertyData_IsOneMemberWithAVariantPerLeaf()
    {
        var scriptElement = RequireElementType(Member(Column("npc_", "VirtualMachineAdapter"), "Scripts"));
        var property = RequireElementType(Member(scriptElement, "Properties"));
        var data = Member(property, "Data");

        Assert.Equivalent(new Dictionary<string, string>
        {
            [nameof(ScriptIntProperty)] = "int",
            [nameof(ScriptFloatProperty)] = "float",
            [nameof(ScriptBoolProperty)] = "bool",
            [nameof(ScriptStringProperty)] = "string",
            [nameof(ScriptIntListProperty)] = "int[]",
            [nameof(ScriptFloatListProperty)] = "float[]",
            [nameof(ScriptBoolListProperty)] = "bool[]",
            [nameof(ScriptStringListProperty)] = "string[]",
            [nameof(ScriptVariableProperty)] = "int",
            [nameof(ScriptVariableListProperty)] = "int[]",
        }, RequireVariants(data).ToDictionary(v => v.Key, v => v.Value.IsArray ? RequireElementType(v.Value).Type + "[]" : v.Value.Type), strict: true);
        Assert.Single(RequireFields(property), f => f.Name == "Data");
    }

    [Fact]
    public void DamageTypes_IsOneColumnWithAVariantPerRecordClass()
    {
        var damageTypes = Column("dmgt", "DamageTypes");
        var variants = RequireVariants(damageTypes);

        Assert.Equal("struct", RequireElementType(variants[nameof(DamageType)]).Type);
        Assert.Equal("int", RequireElementType(variants[nameof(DamageTypeIndexed)]).Type);
        Assert.DoesNotContain(Schemas["dmgt"].RecordColumns, c => c.Name != "DamageTypes" && c.Name.Contains("Damage", StringComparison.Ordinal));
    }

    [Fact]
    public void AVariantMap_IsKeyedByTheDiscriminatorsOwnDomain()
    {
        var offenders =
            from owner in SchemaFields.All(GameRelease.Fallout4)
            let fields = owner.Field.Fields ?? []
            let domain = fields.SingleOrDefault(f => f.IsDiscriminator)?.EnumMembers.Select(m => m.Value).ToHashSet(StringComparer.Ordinal)
            from field in fields
            let variants = field.Variants
            where variants is not null
            from leaf in domain is null ? ["<no discriminator beside it>"] : variants.Keys.Where(k => !domain.Contains(k))
            select $"{owner.Path}.{field.Name}: {leaf}";

        Assert.Empty(offenders);
    }
}
