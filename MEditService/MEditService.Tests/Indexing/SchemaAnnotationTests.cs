using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Indexing;

/// <summary>An annotation naming a type or member reflection did not find fails schema generation,
/// so a Mutagen rename can never leave a stale annotation silently doing nothing.</summary>
public sealed class SchemaAnnotationTests
{
    private static void AssertFailsNaming(SchemaReflector reflector, string entry)
    {
        var ex = Assert.Throws<InvalidOperationException>(() => reflector.GetSchemas(GameRelease.Fallout4));
        Assert.Contains(entry, ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("INpcGetter", "NoSuchMember")]   // the type resolves, the member does not
    [InlineData("INoSuchGetter", "Name")]        // the type does not resolve at all
    public void ExcludedMember_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(string type, string member)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { ExcludedMembers = [.. a.ExcludedMembers, (type, member)] });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Theory]
    [InlineData("ICellGetter", "NoSuchMember")]
    [InlineData("INoSuchGetter", "Timestamp")]
    public void ExcludedColumn_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(string type, string member)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { ExcludedColumns = [.. a.ExcludedColumns, (type, member)] });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Theory]
    [InlineData("INoSuchGetter", "IsPartialForm", "MajorRecordFlagsRaw", "0x4000", "INoSuchGetter")]
    [InlineData("ICellGetter", "IsPartialForm", "NoSuchMember", "0x4000", "backs onto NoSuchMember")]
    [InlineData("IFallout4ModHeaderGetter", "IsSmallMaster", "Flags", "NoSuchFlag", "names flag NoSuchFlag")]
    [InlineData("ICellGetter", "IsPartialForm", "MajorRecordFlagsRaw", "Small", "neither an enum nor an integer bit Small")]
    public void SyntheticFlagMember_ReflectionCannotBackOrTheEnumDoesNotDefine_FailsSchemaGenerationNamingTheEntry(
        string type, string member, string backing, string flag, string named)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SyntheticFlagMembers = new(a.SyntheticFlagMembers) { [(type, member)] = (backing, flag) },
        });
        AssertFailsNaming(reflector, named);
    }

    [Theory]
    [InlineData("IKeywordGetter", "NoSuchMember")]
    [InlineData("INoSuchGetter", "Color")]
    public void AlphaBearingColorField_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(string type, string member)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { AlphaBearingColorFields = [.. a.AlphaBearingColorFields, (type, member)] });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Theory]
    [InlineData("IScriptEntryGetter", "NoSuchMember", "Name", "IScriptEntryGetter.NoSuchMember")]
    [InlineData("INoSuchGetter", "Properties", "Name", "INoSuchGetter.Properties")]
    // The member resolves but is not a list at all — a key means nothing without elements to key.
    [InlineData("IScriptEntryGetter", "Name", "Name", "IScriptEntryGetter.Name is not a list")]
    // The key names a member its element does not have. This fails quietly without validation: every
    // element would share the empty key, collapsing the array to one compare row and refusing every
    // second element as a duplicate on write.
    [InlineData("IScriptEntryGetter", "Properties", "NoSuchKey", "names key NoSuchKey, which IScriptPropertyGetter does not reach at NoSuchKey")]
    // A key that reaches a list rather than a value — one element, one key.
    [InlineData("IAVirtualMachineAdapterGetter", "Scripts", "Properties", "which is itself a list")]
    // A dotted key whose first hop is a scalar, so there is nothing to descend into.
    [InlineData("IAVirtualMachineAdapterGetter", "Scripts", "Name.Alias", "whose Name hop is not a struct to descend into")]
    public void KeyedArray_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(
        string type, string member, string key, string expected)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            KeyedArrays = new(a.KeyedArrays) { [(type, member)] = new[] { key } },
        });
        AssertFailsNaming(reflector, expected);
    }

    [Fact]
    public void ExcludedUnion_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { ExcludedUnions = [.. a.ExcludedUnions, "ANoSuchUnion"] });
        AssertFailsNaming(reflector, "ANoSuchUnion");
    }

    [Fact]
    public void EmptySubSchemaType_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { EmptySubSchemaTypes = [.. a.EmptySubSchemaTypes, "INoSuchGetter"] });
        AssertFailsNaming(reflector, "INoSuchGetter");
    }

    // A SiblingsInUse row is three claims about the assembly at once: the governing member exists, its
    // domain has the values the map is keyed by, and the members it names are real. One wrong claim
    // would silently govern nothing.

    [Theory]
    [InlineData("IFunctionConditionDataGetter", "NoSuchMember")]
    [InlineData("INoSuchGetter", "Function")]
    public void SiblingsInUse_GoverningMemberReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(string type, string member)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SiblingsInUse = new(a.SiblingsInUse) { [(type, member)] = new Dictionary<string, IReadOnlyList<string>>() },
        });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Fact]
    public void SiblingsInUse_GoverningFromANonEnumMember_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SiblingsInUse = new(a.SiblingsInUse)
            {
                [("IFunctionConditionDataGetter", "ParameterOneString")] = new Dictionary<string, IReadOnlyList<string>>(),
            },
        });
        AssertFailsNaming(reflector, "IFunctionConditionDataGetter.ParameterOneString governs from a non-enum member (String)");
    }

    [Fact]
    public void SiblingsInUse_NamingAValueTheDomainDoesNotHave_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SiblingsInUse = new(a.SiblingsInUse)
            {
                [("IConditionDataGetter", "RunOnType")] =
                    Fallout4ConditionAnnotations.RunOnReference
                        .Append(new KeyValuePair<string, IReadOnlyList<string>>("NoSuchRunOn", []))
                        .ToDictionary(kv => kv.Key, kv => kv.Value),
            },
        });
        AssertFailsNaming(reflector, "IConditionDataGetter.RunOnType names value NoSuchRunOn, which RunOnType does not have");
    }

    [Fact]
    public void SiblingsInUse_OmittingAValueTheDomainHas_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SiblingsInUse = new(a.SiblingsInUse)
            {
                [("IConditionDataGetter", "RunOnType")] =
                    Fallout4ConditionAnnotations.RunOnReference
                        .Where(kv => kv.Key != nameof(Condition.RunOnType.MyKiller))
                        .ToDictionary(kv => kv.Key, kv => kv.Value),
            },
        });
        AssertFailsNaming(reflector, "IConditionDataGetter.RunOnType does not name value MyKiller, which RunOnType has");
    }

    [Fact]
    public void SiblingsInUse_NamingASiblingTheTypeDoesNotDeclare_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SiblingsInUse = new(a.SiblingsInUse)
            {
                [("IConditionDataGetter", "RunOnType")] =
                    Fallout4ConditionAnnotations.RunOnReference
                        .ToDictionary(kv => kv.Key, kv => kv.Key == "Reference" ? (IReadOnlyList<string>)["no_such_sibling"] : kv.Value),
            },
        });
        AssertFailsNaming(reflector, "IConditionDataGetter.RunOnType names sibling no_such_sibling, which IConditionDataGetter does not declare");
    }

    [Fact]
    public void ExcludedSignature_TheGameDeclaresNoSuchGrup_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            ExcludedSignatures = new(a.ExcludedSignatures) { ["zzzz"] = "no reason at all" },
        });
        AssertFailsNaming(reflector, "zzzz is no GRUP signature");
    }

    [Fact]
    public void VectorStructType_NoMemberHoldsThatShape_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            VectorStructTypes = [.. a.VectorStructTypes, "Noggog.P3Double"],
        });
        AssertFailsNaming(reflector, "Noggog.P3Double is the shape of no member");
    }

    [Fact]
    public void RefusedShape_NoMemberHoldsThatShape_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            RefusedShapes = new(a.RefusedShapes) { ["NoSuchShape"] = "10 fields; undecided" },
        });
        AssertFailsNaming(reflector, "NoSuchShape is the shape of no member");
    }

    [Fact]
    public void KnownDefect_ReflectionDidNotFindTheMember_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            KnownDefects = [.. a.KnownDefects, new("INpcGetter", "NoSuchMember", KnownDefectEffect.MemberReadOnly, "why")],
        });
        AssertFailsNaming(reflector, "KnownDefects: INpcGetter.NoSuchMember");
    }

    // The existence check answers for a type reflection cannot find; these four say the row is not
    // the kind of thing its table claims, which existence alone would let through.

    [Fact]
    public void ExcludedUnion_ResolvesToNoUnionBase_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            ExcludedUnions = [.. a.ExcludedUnions, "ScriptStringProperty"],
        });
        AssertFailsNaming(reflector, "ScriptStringProperty is no union base");
    }

    [Theory]
    [InlineData("IKeywordGetter", "Color", "is no form link")]
    [InlineData("ISceneActionGetter", "Topic", "is already a nullable form link")]
    public void PermittedNullFormLink_IsNoNonNullableLink_FailsSchemaGenerationNamingTheEntry(
        string type, string member, string named)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            PermittedNullFormLinks = [.. a.PermittedNullFormLinks, (type, member)],
        });
        AssertFailsNaming(reflector, $"{type}.{member} {named}");
    }

    [Fact]
    public void AlphaBearingColorField_IsNoColor_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            AlphaBearingColorFields = [.. a.AlphaBearingColorFields, ("IKeywordGetter", "Type")],
        });
        AssertFailsNaming(reflector, "IKeywordGetter.Type is no Color");
    }

    [Fact]
    public void CycleTruncation_TheWalkNeverReEntersIt_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            CycleTruncations = [.. a.CycleTruncations, "INpcGetter"],
        });
        AssertFailsNaming(reflector, "INpcGetter is never re-entered by the walk");
    }

    [Fact]
    public void EmptySubSchemaType_NeverComesOutEmpty_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            EmptySubSchemaTypes = [.. a.EmptySubSchemaTypes, "IScriptEntryGetter"],
        });
        AssertFailsNaming(reflector, "IScriptEntryGetter never comes out empty in the walk");
    }

    [Theory]
    [InlineData("INoSuchGetter", "Flags", "NoSuchFlag", "EnumMemberLabels: INoSuchGetter.Flags")]
    [InlineData("IFallout4ModHeaderGetter", "Author", "NoSuchFlag", "labels members of String, which is not an enum")]
    [InlineData("IFallout4ModHeaderGetter", "Flags", "NoSuchFlag", "labels member NoSuchFlag, which HeaderFlag does not define")]
    public void EnumMemberLabel_LabelsNoMemberOfAnEnum_FailsSchemaGenerationNamingTheEntry(
        string type, string member, string labelled, string named)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            EnumMemberLabels = new(a.EnumMemberLabels)
            {
                [(type, member)] = new Dictionary<string, string> { [labelled] = "xEdit's own" },
            },
        });
        AssertFailsNaming(reflector, named);
    }

    [Fact]
    public void ShippedFallout4Table_EveryEntryResolves()
    {
        // The production table, through the production seam: a stale row fails here, not in a user's
        // first load.
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        Assert.NotEmpty(schemas);
    }
}
