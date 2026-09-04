using System.Collections.Concurrent;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>The reflected record schema for one game: every record type a Mutagen game assembly
/// declares, presented as a table of columns, built once per game category and cached. The front
/// door to this folder — the modules alongside it decide what one reflected property becomes, and
/// nothing outside calls them directly.</summary>
public sealed class SchemaReflector
{
    private readonly ILogger _logger;
    private readonly Func<GameCategory, SchemaAnnotations> _annotationsFor;

    public SchemaReflector(ILogger<SchemaReflector>? logger = null) : this(SchemaAnnotations.For, logger) { }

    /// <summary>Test seam: the annotation tables to overlay, in place of the shipped ones.</summary>
    internal SchemaReflector(Func<GameCategory, SchemaAnnotations> annotationsFor, ILogger<SchemaReflector>? logger = null)
    {
        _annotationsFor = annotationsFor;
        // Stryker disable once NullCoalescing: logger init; only usage is a defensive LogTrace in catch — unreachable from tests without artificial exception injection
        _logger = logger ?? NullLogger<SchemaReflector>.Instance;
    }

    // Deliberate product filter: not standard editable refs (placed refr/achr are
    // indexed as normal records so the worldspace tree, record editor, and agent queries are
    // uniform DuckDB reads; their cell parentage lives in the `placement` side table — land/
    // navm/navi don't get that treatment).
    private static readonly HashSet<string> NonEditableRefTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "land", "navm", "navi",
    };

    // xEdit-signature-variant collapsing: rare REFR-flavor placement types (projectile/hazard/
    // etc. placements) that mEdit doesn't surface as distinct record types.
    private static readonly HashSet<string> XEditRefSignatureVariants = new(StringComparer.OrdinalIgnoreCase)
    {
        "pgre", "pmis", "parw", "pbar", "pbea", "pcon", "pfla", "phzd",
    };

    private static readonly HashSet<string> ExcludedTables =
        new(NonEditableRefTypes.Concat(XEditRefSignatureVariants), StringComparer.OrdinalIgnoreCase);

    private sealed record GameSchemaCache(
        IReadOnlyDictionary<string, RecordTableSchema> Schemas,
        GameReflection Game);

    private readonly ConcurrentDictionary<GameCategory, GameSchemaCache> _cache = new();

    // Keyed by category (not release) because the assembly is category-wide — a `null` entry
    // means that category's assembly was probed once and found unreferenced, cached so a repeated
    // ask never re-attempts the load or re-logs the warning below.
    private readonly ConcurrentDictionary<GameCategory, Assembly?> _assemblyByCategory = new();

    public IReadOnlyDictionary<string, RecordTableSchema> GetSchemas(GameRelease release)
    {
        var category = release.ToCategory();
        var assembly = ResolveAssembly(release, category)
            ?? throw new UnsupportedGameReleaseException(release, AssemblyNameFor(category));
        return GetCache(category, assembly).Schemas;
    }

    /// <summary>
    /// Reports whether <paramref name="release"/>'s backing Mutagen record-type assembly is
    /// referenced by this build — never throws. Discovery walking multiple installs should
    /// call this before <see cref="GetSchemas"/> to decide whether a release is offered at all.
    /// </summary>
    public bool IsSupported(GameRelease release) => ResolveAssembly(release, release.ToCategory()) is not null;

    private static string AssemblyNameFor(GameCategory category) => $"Mutagen.Bethesda.{category}";

    // The one place that probes whether a category's Mutagen assembly is loadable. Never throws:
    // a `FileNotFoundException` from `Assembly.Load` means "not referenced in this build", which is
    // reported (cached `null`, one warning) rather than propagated — GetSchemas is what turns an
    // unsupported category into a typed refusal for a caller that actually needs one.
    private Assembly? ResolveAssembly(GameRelease release, GameCategory category) =>
        _assemblyByCategory.GetOrAdd(category, c => ProbeAssembly(release, c, _logger));

    private static Assembly? ProbeAssembly(GameRelease release, GameCategory category, ILogger logger)
    {
        var assemblyName = AssemblyNameFor(category);
        var loaded = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(a => a.GetName().Name == assemblyName);
        if (loaded != null) return loaded;

        try
        {
            return Assembly.Load(assemblyName);
        }
        catch (FileNotFoundException ex)
        {
            logger.LogWarning(ex,
                "Game release {Release} is unavailable: Mutagen assembly {AssemblyName} is not referenced in this build",
                release, assemblyName);
            return null;
        }
    }

    private GameSchemaCache GetCache(GameCategory category, Assembly assembly) =>
        _cache.GetOrAdd(category, c => BuildForCategory(c, assembly, _annotationsFor(c), _logger));

    private static GameSchemaCache BuildForCategory(
        GameCategory category, Assembly assembly, SchemaAnnotations annotations, ILogger logger)
    {
        annotations.Validate(assembly);

        var majorRecordGetterType =
            assembly.GetType($"Mutagen.Bethesda.{category}.I{category}MajorRecordGetter")!;

        // A GRUP signature can be backed by several concrete Mutagen subclasses sharing one
        // abstract base — GameSettingInt/Float/String/Bool/UInt are all GMST, GlobalInt/Float/
        // Short/Bool are all GLOB, DamageType/DamageTypeIndexed are both DMGT — because the type
        // discriminant lives on the record itself (an EditorID prefix, a subrecord, ...), never on
        // the table. `discovered`/`seenTables` still record one winner per table (RecordType stays
        // bound to it, deliberately — see BuildSchema), but `siblingsByTable`
        // keeps every concrete type sharing a signature so BuildSchema can union their columns —
        // silently dropping the loser's shape would make a GameSetting's Data column only ever
        // work for whichever subclass reflection happened to enumerate first.
        var seenTables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var discovered = new List<(string tableName, Type getterType)>();
        var siblingsByTable = new Dictionary<string, List<Type>>(StringComparer.OrdinalIgnoreCase);

        foreach (var type in assembly.GetTypes())
        {
            if (type.IsAbstract || type.IsInterface) continue;
            if (!majorRecordGetterType.IsAssignableFrom(type)) continue;

            var grupField = type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static);
            if (grupField == null) continue;

            var recordType = (RecordType)grupField.GetValue(null)!;
            var tableName = recordType.Type.ToLowerInvariant();

            if (ExcludedTables.Contains(tableName)) continue;

            var getterInterface = assembly.GetType($"Mutagen.Bethesda.{category}.I{type.Name}Getter")!;

            if (!siblingsByTable.TryGetValue(tableName, out var siblings))
                siblingsByTable[tableName] = siblings = [];
            siblings.Add(getterInterface);

            if (!seenTables.Add(tableName)) continue;

            discovered.Add((tableName, getterInterface));
        }

        // Every sibling getter type resolves to its table, not just the winner — otherwise a
        // FormLink<IGameSettingFloatGetter> anywhere in the schema fails to resolve
        // ValidFormKeyTypes to ["gmst"] whenever Float isn't that run's winner
        // (LeafClassification.GetFormLinkValidTypes looks types up in this same dictionary).
        var game = new GameReflection(
            siblingsByTable
                .SelectMany(kv => kv.Value.Select(t => (Type: t, Table: kv.Key)))
                .ToDictionary(x => x.Type, x => x.Table),
            annotations);

        // Resolved once per category (condition codecs are stateless per-call factories,
        // and the codec itself doesn't vary per table) — passed into BuildSchema so it can skip
        // condition-shaped properties the same way the header members are skipped, keeping the
        // Conditions section (Fallout4ConditionCodec.Extract) as the one place they're surfaced.
        var conditionCodec = ConditionCodecRegistry.For(category);

        // Resolved once per category, game-neutral like everything else here — each game
        // assembly declares its own IHaveVirtualMachineAdapterGetter in its flat
        // Mutagen.Bethesda.{category} namespace (no shared cross-game interface exists), the same
        // one Records/DuckDbRecordIndex.IndexVmad keys off for a given game's compiled type.
        // Null (a hypothetical future game without the concept) means no table in that category
        // can ever carry VMAD.
        var vmadInterfaceType = assembly.GetType($"Mutagen.Bethesda.{category}.IHaveVirtualMachineAdapterGetter");

        var schemas = new Dictionary<string, RecordTableSchema>();
        foreach (var (tableName, getterType) in discovered)
        {
            schemas[tableName] = BuildSchema(
                tableName, getterType, siblingsByTable[tableName],
                game, logger, conditionCodec, vmadInterfaceType);
        }

        ModHeaderSchema.AddHeaderSchemaIfAvailable(schemas, category, assembly, game, logger);

        return new GameSchemaCache(schemas, game);
    }

    // RecordType (used for enumeration in DuckDbRecordIndex.IndexRecordTable) stays bound to
    // the discovery winner, deliberately, even though RecordColumns below is unioned across every
    // sibling. Enumeration already returns every sibling's records no matter which one's getter
    // interface is named — Mutagen's own EnumerateMajorRecords falls back through
    // InheritingInterfaceMapping to the abstract group base (e.g. IGameSettingGetter) and the group
    // enumerator returns every element once the requested type is assignable to it. So RecordType
    // has nothing to gain from pointing at the abstract base.
    private static RecordTableSchema BuildSchema(
        string tableName, Type getterType, List<Type> siblingGetterTypes,
        GameReflection game, ILogger logger,
        IConditionCodec? conditionCodec, Type? vmadInterfaceType)
    {
        var columns = ColumnReflection.ReflectColumns(getterType, conditionCodec, game, logger);

        // Union in every other concrete subclass sharing this signature (siblingGetterTypes
        // is just [getterType] for the overwhelming majority of tables, so this loop is a no-op
        // there). The rule is expressed purely in terms of a column's *shape*, never a table or
        // signature name, so a hypothetical third subclass of an existing signature — or a
        // brand-new game's own multi-subclass signature — is handled the same way with no code
        // change here. See SiblingColumns.MergeSiblingColumn for the shape rule itself.
        if (siblingGetterTypes.Count > 1)
        {
            var widenedDispatch = new Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>>();
            var nonScalarMergeDispatch = new Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>>();
            foreach (var sibling in siblingGetterTypes)
            {
                if (sibling == getterType) continue;
                var siblingColumns = ColumnReflection.ReflectColumns(sibling, conditionCodec, game, logger);
                foreach (var siblingSpec in siblingColumns)
                    SiblingColumns.MergeSiblingColumn(columns, widenedDispatch, nonScalarMergeDispatch, getterType, sibling, siblingSpec);
            }
        }

        return new RecordTableSchema
        {
            TableName = tableName,
            DisplayName = RecordDisplayNames.For(tableName),
            RecordType = getterType,
            RecordColumns = columns,
            HasVmad = vmadInterfaceType?.IsAssignableFrom(getterType) ?? false,
        };
    }

    /// <summary>One leaf's write capability, flattened for the read/write symmetry audit (#649
    /// commitment 3 / AC #2). Facts only — where the leaf is, the Loqui getter type it decomposes,
    /// and the reason it declared if it is read-only. Deliberately silent on whether the leaf
    /// <i>ought</i> to be writable: the audit re-derives that independently from Mutagen, so this
    /// cannot hand the audit the answer it is checking.</summary>
    internal sealed record LeafWriteFact(string Path, Type? StructGetterType, string? ReadOnlyReason);

    /// <summary>
    /// Every top-level column, plus every nested Loqui-struct member one level in, with the write
    /// capability each actually declared. Re-invokes the real production builders
    /// (<see cref="SubFieldReflection.GetSubFieldInfo"/>) rather than re-deriving anything, so reverting a write path
    /// changes what this reports — which is what makes the audit that reads it non-vacuous.
    ///
    /// <para>Answers two facts about a leaf rather than handing back the <see cref="SubFieldSpec"/>
    /// itself: the audit needs the facts, not the leaf.</para>
    /// </summary>
    internal IReadOnlyList<LeafWriteFact> EnumerateWriteCapability(GameRelease release)
    {
        var category = release.ToCategory();
        var assembly = ResolveAssembly(release, category)
            ?? throw new UnsupportedGameReleaseException(release, AssemblyNameFor(category));
        var cache = GetCache(category, assembly);

        var facts = new List<LeafWriteFact>();
        foreach (var (table, schema) in cache.Schemas)
        {
            foreach (var column in schema.RecordColumns)
            {
                facts.Add(new($"{table}.{column.Name}", null, column.Apply.ReadOnlyReason));

                // Only this schema's own properties: a sibling-merged column belongs to another
                // getter type and is walked on that type's own table instead.
                var prop = ReflectedTypes.GetAllInterfaceProperties(schema.RecordType)
                    .FirstOrDefault(p => p.Name == column.PropertyName);
                if (prop == null) continue;

                var core = Nullable.GetUnderlyingType(prop.PropertyType) ?? prop.PropertyType;
                if (ReflectedTypes.IsListType(core, out var element)) core = element;
                if (!ReflectedTypes.IsLoquiInterface(core) || ReflectedTypes.IsFormLink(core)) continue;

                foreach (var member in ReflectedTypes.GetAllInterfaceProperties(core)
                             .Where(p => !cache.Game.Annotations.IsExcludedMember(p)))
                {
                    if (SubFieldReflection.GetSubFieldInfo(member, cache.Game, [core], 1, _logger) is not { } spec) continue;

                    // The LEAF's own shape, not its enclosing struct's: an unconvertible-element list
                    // or an excluded VMAD struct inside a perfectly writable struct is not itself
                    // writable-shaped, and reporting the parent here would accuse it of lying.
                    var leaf = Nullable.GetUnderlyingType(member.PropertyType) ?? member.PropertyType;
                    var leafStruct = ReflectedTypes.IsLoquiInterface(leaf) && !ReflectedTypes.IsFormLink(leaf) ? leaf : null;
                    facts.Add(new($"{table}.{column.Name}.{spec.Name}", leafStruct, spec.Apply.ReadOnlyReason));
                }
            }
        }
        return facts;
    }

}

/// <summary>
/// Thrown by <see cref="SchemaReflector.GetSchemas"/> when a game release's backing Mutagen
/// record-type assembly is not referenced by this build — e.g. requesting Skyrim while
/// <c>Mutagen.Bethesda.Skyrim</c> isn't referenced. Distinguishes "this release isn't compiled in" from
/// Mutagen's own <see cref="FileNotFoundException"/>, which is not an actionable message for a
/// caller. <see cref="SchemaReflector.IsSupported"/> is the non-throwing check discovery should
/// use instead of catching this.
/// </summary>
public sealed class UnsupportedGameReleaseException : Exception
{
    // RCS1194: the three standard exception constructors, for well-behaved rethrow/serialization
    // callers generally — not how SchemaReflector itself throws this (see the release-based
    // constructor below), which builds a specific, actionable message naming the missing assembly.
    public UnsupportedGameReleaseException()
    {
    }

    public UnsupportedGameReleaseException(string message) : base(message)
    {
    }

    public UnsupportedGameReleaseException(string message, Exception innerException) : base(message, innerException)
    {
    }

    internal UnsupportedGameReleaseException(GameRelease release, string assemblyName)
        : base($"Game release '{release}' is not supported by this build: the Mutagen assembly '{assemblyName}' is not referenced.")
    {
        Release = release;
    }

    public GameRelease Release { get; }
}
