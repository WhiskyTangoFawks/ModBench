using System.Collections.Concurrent;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>The reflected record schema for one game, built once per category and cached. The front
/// door to this folder: the modules alongside decide what one property becomes, and nothing outside
/// calls them directly.</summary>
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

    // Placed refr/achr are indexed as normal records, with cell parentage in the placement side
    // table; land/navm/navi get no such treatment.
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

    // Keyed by category because the assembly is category-wide; a null entry means the assembly was
    // probed once and found unreferenced, so a repeated ask never re-logs.
    private readonly ConcurrentDictionary<GameCategory, Assembly?> _assemblyByCategory = new();

    public IReadOnlyDictionary<string, RecordTableSchema> GetSchemas(GameRelease release)
    {
        var category = release.ToCategory();
        var assembly = ResolveAssembly(release, category)
            ?? throw new UnsupportedGameReleaseException(release, AssemblyNameFor(category));
        return GetCache(category, assembly).Schemas;
    }

    /// <summary>Never throws. Discovery walking several installs asks this before
    /// <see cref="GetSchemas"/> to decide whether a release is offered at all.</summary>
    public bool IsSupported(GameRelease release) => ResolveAssembly(release, release.ToCategory()) is not null;

    private static string AssemblyNameFor(GameCategory category) => $"Mutagen.Bethesda.{category}";

    // Never throws: FileNotFoundException from Assembly.Load means "not referenced in this build" and
    // is cached as null with one warning; GetSchemas turns that into a typed refusal.
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

        // One GRUP signature can be backed by several concrete subclasses (GMST, GLOB, DMGT) because
        // the discriminant lives on the record, not the table. One winner per table keeps RecordType
        // bound; siblingsByTable keeps every subclass so BuildSchema can union their columns.
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

        // Every sibling resolves to its table, not just the winner, or a FormLink to a non-winning
        // sibling would fail to resolve its ValidFormKeyTypes.
        var game = new GameReflection(
            siblingsByTable
                .SelectMany(kv => kv.Value.Select(t => (Type: t, Table: kv.Key)))
                .ToDictionary(x => x.Type, x => x.Table),
            annotations,
            new DeclaredDefaults(category.DefaultRelease(), logger));

        var schemas = new Dictionary<string, RecordTableSchema>();
        foreach (var (tableName, getterType) in discovered)
        {
            schemas[tableName] = BuildSchema(
                tableName, getterType, siblingsByTable[tableName], game, logger);
        }

        ModHeaderSchema.AddHeaderSchemaIfAvailable(schemas, category, assembly, game, logger);

        return new GameSchemaCache(schemas, game);
    }

    // RecordType stays bound to the discovery winner even though the columns are unioned: Mutagen's
    // EnumerateMajorRecords falls back to the abstract group base and returns every sibling's records
    // anyway, so pointing at the base would gain nothing.
    private static RecordTableSchema BuildSchema(
        string tableName, Type getterType, List<Type> siblingGetterTypes,
        GameReflection game, ILogger logger)
    {
        var columns = ColumnReflection.ReflectColumns(getterType, game, logger);

        // Decided by column shape, never table or signature name, so another game's multi-subclass
        // signature needs no change. The table is a union at the record level: its document names
        // its class first, and the discriminator column carries it.
        if (siblingGetterTypes.Count > 1)
        {
            var union = LoquiUnions.RecordUnion(siblingGetterTypes);
            var classNames = union.Leaves.ToDictionary(l => l.GetterType, l => l.ClassName);
            var writersByColumn = new Dictionary<string, List<SiblingColumns.WriterByClass>>();
            foreach (var sibling in siblingGetterTypes)
            {
                if (sibling == getterType) continue;
                var siblingColumns = ColumnReflection.ReflectColumns(sibling, game, logger);
                foreach (var siblingSpec in siblingColumns)
                {
                    SiblingColumns.MergeSiblingColumn(
                        columns, writersByColumn, getterType, classNames[getterType], sibling, classNames[sibling], siblingSpec);
                }
            }

            var discriminator = LoquiUnions.BuildUnionDiscriminatorField(union);
            columns.Insert(0, new ColumnSpec(
                discriminator.Name, discriminator.Name, "VARCHAR", discriminator.ApiType,
                discriminator.ValidFormKeyTypes, discriminator.EnumMembers,
                LeafWrite.ReadOnly<IMajorRecord>(SchemaRefusals.DiscriminatorReason),
                IsDiscriminator: true, DisplayLabel: discriminator.DisplayLabel));
        }

        return new RecordTableSchema
        {
            TableName = tableName,
            DisplayName = RecordDisplayNames.For(tableName),
            RecordType = getterType,
            RecordColumns = columns,
        };
    }

    /// <summary>Facts only, for the read/write symmetry audit — deliberately silent on whether the
    /// leaf ought to be writable, which the audit re-derives from Mutagen itself.</summary>
    internal sealed record LeafWriteFact(string Path, Type? StructGetterType, string? ReadOnlyReason);

    /// <summary>Re-invokes the real production builders rather than re-deriving anything, so
    /// reverting a write path changes what this reports and the audit stays non-vacuous.</summary>
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

/// <summary>A game release whose Mutagen record-type assembly is not referenced by this build. Its
/// own type because Mutagen's <see cref="FileNotFoundException"/> is not an actionable message for
/// a caller.</summary>
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
