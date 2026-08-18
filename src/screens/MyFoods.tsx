import { useLiveQuery } from 'dexie-react-hooks';
import { useUi } from '../state/ui';
import { useTargets } from '../state/useTargets';
import {
  deleteFood,
  deleteRecipe,
  foodForRecipe,
  listFavorites,
  listOwnFoods,
  listRecipes,
  recipeNutrition,
  toggleFavorite,
} from '../db/repo';
import { N } from '../core/nutrients';
import { formatCount } from '../core/format';
import { displayName } from '../core/foodName';
import { nearestMeal } from '../core/profile';
import type { Food } from '../db/schema';
import { Button, Divider, EmptyState, List, Sheet, Segmented, cx } from '../ui/primitives';
import { IconBook, IconPlus, IconStar, IconTrash } from '../ui/icons';

/**
 * Your foods.
 *
 * Favouriting a food used to nudge it up the search ranking and nothing else —
 * no list, no destination, so the honest answer to "where did it go" was
 * nowhere you can look. Custom foods and recipes had the same problem from the
 * other direction: they existed, but only if you already knew to type their
 * name. This is the one place all three live.
 */
export default function MyFoods() {
  const closeSheet = useUi((s) => s.closeSheet);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);
  const day = useUi((s) => s.day);
  const derived = useTargets();

  // Held in the store, not in this component: opening the recipe builder
  // replaces this sheet, and stepping back rebuilds it from its descriptor.
  const section = useUi((s) => s.librarySection);
  const setSection = useUi((s) => s.setLibrarySection);

  const favorites = useLiveQuery(() => listFavorites(), []);
  const own = useLiveQuery(() => listOwnFoods(), []);
  const recipes = useLiveQuery(() => listRecipes(), []);

  const mealId = derived ? nearestMeal(derived.profile.meals) : 'snacks';
  const open = (food: Food) => openSheet({ kind: 'food-detail', food, mealId, day });

  return (
    <Sheet
      open
      onClose={closeSheet}
      title="Your foods"
      // Both footers are `secondary`, like the search sheet's. `primary` is
      // reserved for the action that commits — "Add 250 kcal", "Save changes" —
      // and these only open another sheet. One tab of three shouting was the
      // tell that the rule had never been written down anywhere.
      footer={
        section === 'recipes' ? (
          <Button variant="secondary" full onClick={() => openSheet({ kind: 'recipe-builder' })}>
            <IconPlus size={17} />
            Create a recipe
          </Button>
        ) : (
          <Button variant="secondary" full onClick={() => openSheet({ kind: 'create-food' })}>
            <IconPlus size={17} />
            Create a custom food
          </Button>
        )
      }
    >
      <div className="sticky top-0 z-10 bg-bg-elevated px-4 py-2.5">
        <Segmented
          value={section}
          onChange={setSection}
          options={[
            { value: 'favorites', label: 'Favourites' },
            { value: 'mine', label: 'My foods' },
            { value: 'recipes', label: 'Recipes' },
          ]}
        />
      </div>

      <div className="px-4 pb-4">
        {section === 'favorites' && (
          <FoodList
            foods={favorites}
            emptyTitle="No favourites yet"
            emptyDetail="Open any food and tap Favourite. It lands here, and it is offered first when you search."
            onOpen={open}
            trailing={(food) => (
              <button
                onClick={async (event) => {
                  event.stopPropagation();
                  await toggleFavorite(food.id);
                  toast(`Removed ${displayName(food.name).primary} from favourites`);
                }}
                aria-label={`Unfavourite ${food.name}`}
                className="rounded-lg p-2 text-brand transition-colors hover:bg-surface-2"
              >
                <IconStar size={16} filled />
              </button>
            )}
          />
        )}

        {section === 'mine' && (
          <FoodList
            foods={own}
            emptyTitle="Nothing of your own yet"
            emptyDetail="Foods you create by hand, and anything built from a scanned label, are kept here."
            onOpen={open}
            trailing={(food) => (
              <button
                onClick={async (event) => {
                  event.stopPropagation();
                  await deleteFood(food.id);
                  toast(`Deleted ${displayName(food.name).primary}`);
                }}
                aria-label={`Delete ${food.name}`}
                className="rounded-lg p-2 text-faint transition-colors hover:bg-surface-2 hover:text-danger"
              >
                <IconTrash size={16} />
              </button>
            )}
          />
        )}

        {section === 'recipes' &&
          (recipes === undefined ? (
            <div className="skeleton mt-3 h-32 rounded-(--radius-card)" />
          ) : recipes.length === 0 ? (
            <EmptyState
              icon={<IconBook size={28} />}
              title="No recipes yet"
              detail="Build one from its ingredients and it becomes a food in its own right — searchable, loggable by the serving, and usable inside another recipe."
              action={
                <Button onClick={() => openSheet({ kind: 'recipe-builder' })}>Create a recipe</Button>
              }
            />
          ) : (
            <List className="mt-3">
              {recipes.map((recipe, index) => {
                const perServing = recipeNutrition(recipe).perServing;
                return (
                  <div key={recipe.id}>
                    {index > 0 && <Divider className="ml-4" />}
                    <div className="flex items-center gap-2 px-3.5 py-3">
                      <button
                        onClick={async () => {
                          const food = await foodForRecipe(recipe.id);
                          if (food) open(food);
                          else toast('This recipe has no saved food yet — open and save it again');
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate text-[14.5px]">{recipe.name}</div>
                        <div className="mt-0.5 truncate text-[12px] text-faint tnum">
                          {formatCount(perServing[N.ENERGY] ?? 0)} kcal per serving ·{' '}
                          {recipe.servings} servings
                        </div>
                      </button>
                      <button
                        onClick={() => openSheet({ kind: 'recipe-builder', recipeId: recipe.id })}
                        aria-label={`Edit ${recipe.name}`}
                        className="shrink-0 rounded-lg px-2.5 py-2 text-[13px] text-brand transition-colors hover:bg-surface-2"
                      >
                        Edit
                      </button>
                      <button
                        onClick={async () => {
                          await deleteRecipe(recipe.id);
                          toast(`Deleted ${recipe.name}`);
                        }}
                        aria-label={`Delete ${recipe.name}`}
                        className="shrink-0 rounded-lg p-2 text-faint transition-colors hover:bg-surface-2 hover:text-danger"
                      >
                        <IconTrash size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </List>
          ))}
      </div>
    </Sheet>
  );
}

function FoodList({
  foods,
  emptyTitle,
  emptyDetail,
  onOpen,
  trailing,
}: {
  foods: Food[] | undefined;
  emptyTitle: string;
  emptyDetail: string;
  onOpen: (food: Food) => void;
  trailing: (food: Food) => React.ReactNode;
}) {
  if (foods === undefined) return <div className="skeleton mt-3 h-32 rounded-(--radius-card)" />;
  if (foods.length === 0) {
    return <EmptyState icon={<IconStar size={28} />} title={emptyTitle} detail={emptyDetail} />;
  }

  return (
    <List className="mt-3">
      {foods.map((food, index) => (
        <div key={food.id}>
          {index > 0 && <Divider className="ml-4" />}
          <div className={cx('flex items-center gap-2 px-3.5 py-3')}>
            <button onClick={() => onOpen(food)} className="min-w-0 flex-1 text-left">
              <div className="truncate text-[14.5px]">{displayName(food.name).primary}</div>
              <div className="mt-0.5 truncate text-[12px] text-faint tnum">
                {[food.brand, `${formatCount(food.per100g[N.ENERGY] ?? 0)} kcal / 100 g`]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </button>
            <span className="shrink-0">{trailing(food)}</span>
          </div>
        </div>
      ))}
    </List>
  );
}
