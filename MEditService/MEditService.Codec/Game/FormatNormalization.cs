using System.Collections;
using System.Collections.Concurrent;
using System.Linq.Expressions;
using System.Reflection;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Codec.Game;

/// <summary>The source's format applied to a record (ADR-0030): each list its customizations sort, sorted, and each
/// member they omit, as a fresh object holds it. Read by running the customizations this project compiles.</summary>
internal static class FormatNormalization
{
    private sealed record Rule(Func<Type, bool> Applies, Action<object> Apply, (Type Declarer, string Member)? Sorted = null);

    private static readonly IReadOnlyList<Rule> Rules = Recorded(typeof(FormatNormalization).Assembly);

    private static readonly RecordGraph Normalized = new(type => Rules.Any(rule => rule.Applies(type)));

    public static IReadOnlyList<(Type Declarer, string Member)> SortedLists { get; } = [.. Rules.Select(rule => rule.Sorted).OfType<(Type, string)>()];

    public static IMajorRecordGetter Of(IMajorRecordGetter record)
    {
        if (!Normalized.CanReach(record.GetType())) return record;
        var copy = record.DeepCopy();
        Normalized.ForEach(copy, node =>
        {
            foreach (var rule in Rules.Where(rule => rule.Applies(node.GetType()))) rule.Apply(node);
        });
        return copy;
    }

    private static List<Rule> Recorded(Assembly codec)
    {
        var rules = new List<Rule>();
        foreach (var type in codec.GetTypes().Where(type => type is { IsClass: true, IsAbstract: false }))
        {
            if (typeof(ICustomize).IsAssignableFrom(type))
                ((ICustomize)New(type)).Customize(new Recorder(rules));
            foreach (var customized in type.GetInterfaces().Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(ICustomize<>)))
            {
                var recorder = New(typeof(Recorder<>).MakeGenericType(customized.GetGenericArguments()[0]), rules);
                customized.GetMethod(nameof(ICustomize<object>.CustomizeFor))?.Invoke(New(type), [recorder]);
            }
        }
        return rules;
    }

    private static object New(Type type, params object[] arguments) =>
        System.Activator.CreateInstance(type, arguments) ?? throw new InvalidOperationException($"Expected {type.Name} to construct.");

    // The whole-format omissions name members by the serialization generator's rules.
    private sealed class Recorder(List<Rule> rules) : IFilePerRecordCustomizationBuilder
    {
        public IFilePerRecordCustomizationBuilder FilePerRecord() => this;

        public IFilePerRecordCustomizationBuilder EnforceRecordOrder() => this;

        public ICustomizationBuilder OmitLastModifiedData() => Omitting(_ => true, name => name == "LastModified");

        public ICustomizationBuilder OmitTimestampData() =>
            Omitting(_ => true, name => name is "Timestamp" or "PersistentTimestamp" or "TemporaryTimestamp" or "SubCellsTimestamp");

        public ICustomizationBuilder OmitUnknownGroupData() =>
            Omitting(_ => true, name => name is "UnknownGroupData" or "PersistentUnknownGroupData" or "TemporaryUnknownGroupData");

        public ICustomizationBuilder OmitUnusedConditionDataFields() =>
            Omitting(
                owner => owner.Name.Contains("ConditionData", StringComparison.Ordinal),
                name => name.Contains("unused", StringComparison.OrdinalIgnoreCase));

        public ICustomizationBuilder SkipRecordsWithErrors() => this;

        private Recorder Omitting(Func<Type, bool> owner, Func<string, bool> member)
        {
            rules.Add(Omission(type => owner(type) ? Settable(type).Where(p => member(p.Name)) : []));
            return this;
        }

        private static IEnumerable<PropertyInfo> Settable(Type type) =>
            type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0 && p.SetMethod is { IsPublic: true });
    }

    private sealed class Recorder<TObject>(List<Rule> rules) : ICustomizationBuilder<TObject>
    {
        public ICustomizationBuilder<TObject> Omit<TField>(Expression<Func<TObject, TField>> field)
        {
            var name = MemberName(field);
            rules.Add(Omission(type => typeof(TObject).IsAssignableFrom(type) ? [Member(type, name)] : []));
            return this;
        }

        public ICustomizationBuilder<TObject> Omit<TField>(Expression<Func<TObject, TField>> field, Func<TObject, TField, bool> predicate) =>
            throw new NotSupportedException($"The format omits '{field}' only where a condition holds, which no recompile tolerance reads yet.");

        public ICustomizationBuilder<TObject> EmbedRecordsInSameFile(Expression<Func<TObject, IMajorRecordGetter?>> field) => this;

        public ICustomizationBuilder<TObject> EmbedRecordsInSameFile(Expression<Func<TObject, IReadOnlyList<IMajorRecordGetter>?>> field) => this;

        public IListSortBuilder<TObject, TItem> SortList<TItem>(Expression<Func<TObject, IEnumerable<TItem>?>> listField)
        {
            var sort = new Sort<TObject, TItem>(this);
            var name = MemberName(listField);
            rules.Add(new Rule(typeof(TObject).IsAssignableFrom, node =>
            {
                if (Member(node.GetType(), name).GetValue(node) is not IList list) return;
                var sorted = sort.Order(list.Cast<TItem>()).ToList();
                list.Clear();
                foreach (var item in sorted) list.Add(item);
            }, (typeof(TObject), name)));
            return sort;
        }

        // The most derived declaration: a class can redeclare a member its base declares.
        private static PropertyInfo Member(Type type, string name)
        {
            for (var declaring = type; declaring is not null; declaring = declaring.BaseType)
            {
                if (declaring.GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly) is { } property) return property;
            }
            throw new InvalidOperationException($"Expected {type.Name} to declare '{name}', which the format names.");
        }

        private static string MemberName(LambdaExpression field)
        {
            var body = field.Body is UnaryExpression { NodeType: ExpressionType.Convert } converted ? converted.Operand : field.Body;
            return (body as MemberExpression)?.Member.Name ?? throw new InvalidOperationException($"Expected '{field}' to name a member.");
        }
    }

    // OrderBy, then ThenBy over each further key, as the generated serializer sorts.
    private sealed class Sort<TObject, TItem>(ICustomizationBuilder<TObject> owner)
        : IListSortBuilder<TObject, TItem>, IListSortFieldChainBuilder<TObject, TItem>
    {
        private Func<IEnumerable<TItem>, IOrderedEnumerable<TItem>>? _order;

        public IEnumerable<TItem> Order(IEnumerable<TItem> items) => _order?.Invoke(items) ?? items;

        public IListSortFieldChainBuilder<TObject, TItem> ByField<TField>(Expression<Func<TItem, TField>> itemField)
        {
            var key = itemField.Compile();
            _order = items => items.OrderBy(key);
            return this;
        }

        public IListSortFieldChainBuilder<TObject, TItem> ThenByField<TField>(Expression<Func<TItem, TField>> itemField)
        {
            var key = itemField.Compile();
            var first = _order ?? throw new InvalidOperationException("Expected ByField before ThenByField.");
            _order = items => first(items).ThenBy(key);
            return this;
        }

        public ICustomizationBuilder<TObject> Omit<TField>(Expression<Func<TObject, TField>> field) => owner.Omit(field);

        public ICustomizationBuilder<TObject> Omit<TField>(Expression<Func<TObject, TField>> field, Func<TObject, TField, bool> predicate) =>
            owner.Omit(field, predicate);

        public ICustomizationBuilder<TObject> EmbedRecordsInSameFile(Expression<Func<TObject, IMajorRecordGetter?>> field) =>
            owner.EmbedRecordsInSameFile(field);

        public ICustomizationBuilder<TObject> EmbedRecordsInSameFile(Expression<Func<TObject, IReadOnlyList<IMajorRecordGetter>?>> field) =>
            owner.EmbedRecordsInSameFile(field);

        public IListSortBuilder<TObject, TOther> SortList<TOther>(Expression<Func<TObject, IEnumerable<TOther>?>> listField) =>
            owner.SortList(listField);
    }

    private static readonly ConcurrentDictionary<Type, object> Fresh = new();

    private static Rule Omission(Func<Type, IEnumerable<PropertyInfo>> members)
    {
        var byType = new ConcurrentDictionary<Type, PropertyInfo[]>();
        PropertyInfo[] Of(Type type) => byType.GetOrAdd(type, owner => [.. members(owner)]);
        return new Rule(type => Of(type).Length > 0, node =>
        {
            var fresh = Fresh.GetOrAdd(node.GetType(), type => System.Activator.CreateInstance(type, nonPublic: true)
                ?? throw new InvalidOperationException($"Expected {type.Name} to construct."));
            foreach (var member in Of(node.GetType())) member.SetValue(node, member.GetValue(fresh));
        });
    }
}
